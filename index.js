import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import { db, admin } from "./firebaseAdmin.js"; // OLD Firestore (DroRide)
import { dbNew, adminNew } from "./firebaseAdminNew.js"; // NEW Firestore (Campus Bike Rental)

dotenv.config();

const app = express();

/* ---------------------------------------------------
   MIDDLEWARE
--------------------------------------------------- */

// Capture RAW body for webhook signature verification
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    }
  })
);

app.use(cors());

/* ---------------------------------------------------
   HEALTH CHECK (For Server Warm-up)
--------------------------------------------------- */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "paychangu-backend",
    projects: ["dride", "campus-bike-rental", "bus-booking"]
  });
});

/* ---------------------------------------------------
   PAY INIT - Handles ALL projects (Bike, Event, Bus)
--------------------------------------------------- */
app.post("/pay", async (req, res) => {
  try {
    const { amount, phone, network, userId, itemId, projectType } = req.body;

    if (!amount || !phone || !network || !userId || !itemId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Determine which project this is for
    const isBikeRental = projectType === "bike_rental" || itemId.startsWith("BIKE_") || itemId.startsWith("EXTENSION_") || itemId.startsWith("LATE_FEE_");
    const isBusBooking = projectType === "bus_booking" || itemId.startsWith("BUS_");
    const paymentRef = crypto.randomUUID();
    
    console.log(`[PAY] Creating payment ${paymentRef} for ${isBikeRental ? 'bike_rental' : isBusBooking ? 'bus_booking' : 'event_ticket'}`);

    // Build metadata based on payment type
    let meta;
    if (itemId.startsWith("EXTENSION_")) {
      // Parse: EXTENSION_{rentalId}_{hours}h
      const parts = itemId.split("_");
      const hours = parseInt(parts[parts.length - 1].replace("h", ""));
      const rentalId = parts.slice(1, parts.length - 1).join("_");
      
      meta = {
        paymentRef,
        userId,
        projectType: "bike_rental",
        paymentType: "extension",
        rentalId: rentalId,
        hours: hours
      };
    } else if (itemId.startsWith("LATE_FEE_")) {
      // Parse: LATE_FEE_{rentalId}
      const rentalId = itemId.replace("LATE_FEE_", "");
      
      meta = {
        paymentRef,
        userId,
        projectType: "bike_rental",
        paymentType: "late_fee",
        rentalId: rentalId
      };
    } else if (itemId.startsWith("BUS_")) {
      // Parse: BUS_{busId}_SEAT_{seatNumber}
      const parts = itemId.split("_");
      const busId = parts[1];
      const seatNumber = parts[3];
      
      meta = {
        paymentRef,
        userId,
        projectType: "bus_booking",
        busId: busId,
        seatNumber: seatNumber,
        itemId: itemId
      };
    } else {
      // Regular bike rental
      meta = {
        paymentRef,
        userId,
        projectType: "bike_rental",
        paymentType: "new_rental",
        bikeId: itemId.split("_").slice(0,2).join("_"),
        duration: parseInt(itemId.split("_")[2]) || 1
      };
    }

    const payResponse = await axios.post(
      "https://api.paychangu.com/payment",
      {
        amount,
        currency: "MWK",
        phone_number: phone,
        network,
        reference: paymentRef,
        callback_url: `${process.env.BACKEND_URL}/webhook`,
        return_url: `${process.env.BACKEND_URL}/payment-success?reference=${paymentRef}`,
        meta: meta,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYCHANGU_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const checkoutUrl = payResponse?.data?.data?.checkout_url;
    if (!checkoutUrl) {
      throw new Error("Checkout URL missing from PayChangu");
    }

    // Store payment in CORRECT Firestore based on project type
    const paymentData = {
      id: paymentRef,
      userId,
      itemId,
      amount,
      phone,
      network,
      status: "PENDING",
      projectType: isBikeRental ? "bike_rental" : isBusBooking ? "bus_booking" : "event_ticket",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (isBikeRental || isBusBooking) {
      // NEW Firestore for bike rentals AND bus bookings
      paymentData.ticketCreated = false; // Using same flag for simplicity
      await dbNew.collection("payments").doc(paymentRef).set(paymentData);
    } else {
      // OLD Firestore for event tickets
      paymentData.ticketCreated = false;
      await db.collection("payments").doc(paymentRef).set(paymentData);
    }

    console.log(`[PAY] Stored payment ${paymentRef} in ${isBikeRental || isBusBooking ? 'NEW' : 'OLD'} Firestore`);
    res.json({ paymentId: paymentRef, checkoutUrl });
  } catch (err) {
    console.error("[PAY ERROR]", err.response?.data || err.message);
    res.status(500).json({ error: "Payment initialization failed" });
  }
});

/* ---------------------------------------------------
   WEBHOOK - Handles ALL projects
--------------------------------------------------- */
app.post("/webhook", async (req, res) => {
  console.log("[WEBHOOK] Received");

  try {
    const payload = req.body;
    console.log("[WEBHOOK] Payload:", JSON.stringify(payload, null, 2));

    // ✅ SAFELY PARSE META
    let meta = payload.meta;

    if (typeof meta === "string") {
      try {
        meta = JSON.parse(meta);
        console.log("[WEBHOOK] Parsed meta:", meta);
      } catch (e) {
        console.error("[WEBHOOK] ❌ Failed to parse meta string");
        return res.sendStatus(400);
      }
    }

    const paymentRef = meta?.paymentRef;
    const projectType = meta?.projectType || "event_ticket";

    if (!paymentRef) {
      console.error("[WEBHOOK] ❌ paymentRef missing after parsing meta");
      return res.sendStatus(400);
    }

    const status = payload.status === "success" ? "SUCCESS" : "FAILED";

    console.log(`[WEBHOOK] paymentRef=${paymentRef} project=${projectType} status=${status}`);

    // Route to correct handler based on project type
    if (projectType === "bike_rental") {
      await handleBikeRentalWebhook(paymentRef, status, meta);
    } else if (projectType === "bus_booking") {
      await handleBusBookingWebhook(paymentRef, status, meta);
    } else {
      await handleEventTicketWebhook(paymentRef, status, meta);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("[WEBHOOK ERROR]", err);
    res.sendStatus(500);
  }
});

/* ---------------------------------------------------
   HANDLE BUS BOOKING WEBHOOK (NEW FIRESTORE)
--------------------------------------------------- */
async function handleBusBookingWebhook(paymentRef, status, meta) {
  console.log(`[WEBHOOK BUS] Processing bus booking: ${paymentRef}`);
  
  const busId = meta?.busId;
  const seatNumber = meta?.seatNumber;
  const userId = meta?.userId;
  
  if (!busId || !seatNumber || !userId) {
    console.error("[WEBHOOK BUS] Missing required fields:", { busId, seatNumber, userId });
    return;
  }
  
  try {
    await dbNew.runTransaction(async (transaction) => {
      const paymentDoc = dbNew.collection("payments").doc(paymentRef);
      const paymentSnap = await transaction.get(paymentDoc);
      
      if (!paymentSnap.exists) {
        console.error(`[WEBHOOK BUS] Payment not found: ${paymentRef}`);
        return;
      }
      
      const payment = paymentSnap.data();
      
      if (payment.ticketCreated) {
        console.log(`[WEBHOOK BUS] Already processed: ${paymentRef}`);
        return;
      }
      
      // Update payment status
      transaction.update(paymentDoc, {
        status: status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      
      if (status !== "SUCCESS") {
        console.log(`[WEBHOOK BUS] Payment not successful: ${status}`);
        return;
      }
      
      // Get bus data
      const busRef = dbNew.collection("bus_bookings").doc(busId);
      const busSnap = await transaction.get(busRef);
      
      if (!busSnap.exists) {
        console.error(`[WEBHOOK BUS] Bus not found: ${busId}`);
        return;
      }
      
      const busData = busSnap.data();
      
      // Get user data for ticket
      const userRef = dbNew.collection("users").doc(userId);
      const userSnap = await transaction.get(userRef);
      const userData = userSnap.exists ? userSnap.data() : {};
      
      // Find and update the specific seat
      const seats = busData.seats || [];
      const seatIndex = seats.findIndex(s => s.seatNumber === seatNumber);
      
      if (seatIndex === -1) {
        console.error(`[WEBHOOK BUS] Seat ${seatNumber} not found on bus ${busId}`);
        return;
      }
      
      const seat = seats[seatIndex];
      
      // Check if seat is already booked
      if (seat.status === "BOOKED") {
        console.error(`[WEBHOOK BUS] Seat ${seatNumber} already booked!`);
        return;
      }
      
      // Generate ticket code
      const ticketCode = `BUS-${busId.substring(0, 8).toUpperCase()}-${seatNumber}-${Date.now().toString(36).toUpperCase()}`;
      
      // Update seat in bus_bookings
      const updatedSeats = [...seats];
      updatedSeats[seatIndex] = {
        ...seat,
        status: "BOOKED",
        bookedBy: userId,
        bookedByName: userData.name || "Unknown",
        studentId: userData.studentId || "",
        bookedAt: admin.firestore.FieldValue.serverTimestamp(),
        ticketCode: ticketCode,
        price: payment.amount
      };
      
      transaction.update(busRef, {
        seats: updatedSeats,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Create bus ticket
      const ticketId = `BUS_TICKET_${paymentRef}`;
      const ticketData = {
        id: ticketId,
        ticketCode: ticketCode,
        busId: busId,
        busName: busData.busName || "Unknown Bus",
        busCompany: busData.busCompany || "",
        busNumber: busData.busNumber || "",
        seatNumber: seatNumber,
        seatType: seat.type || "REGULAR",
        
        // Route info
        fromLocation: busData.fromLocation || "",
        toLocation: busData.toLocation || "",
        departureDate: busData.departureDate || null,
        departureTime: busData.departureTime || "",
        arrivalTime: busData.arrivalTime || "",
        
        // Student info
        studentId: userId,
        studentName: userData.name || "",
        studentPhone: userData.phone || "",
        studentIdNumber: userData.studentId || "",
        
        // Organizer info
        organizerId: busData.organizerId || "",
        organizerName: busData.organizerName || "",
        organizerPhone: busData.organizerPhone || "",
        
        // Payment info
        bookingFee: payment.amount,
        totalPrice: busData.totalPrice || payment.amount,
        paymentId: paymentRef,
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        
        // Status
        status: "VALID", // VALID, USED, CANCELLED, EXPIRED
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        
        // QR data
        qrData: ticketCode
      };
      
      transaction.set(dbNew.collection("bus_tickets").doc(ticketId), ticketData);
      
      // Mark payment as processed
      transaction.update(paymentDoc, { ticketCreated: true });
      
      console.log(`[WEBHOOK BUS] ✅ Bus ticket created: ${ticketId}, Code: ${ticketCode}`);
    });
  } catch (error) {
    console.error("[WEBHOOK BUS] Error:", error);
  }
}

/* ---------------------------------------------------
   HANDLE BIKE RENTAL WEBHOOK (NEW FIRESTORE)
--------------------------------------------------- */
async function handleBikeRentalWebhook(paymentRef, status, meta) {
  const paymentType = meta?.paymentType || "new_rental";
  
  console.log(`[WEBHOOK BIKE] Type: ${paymentType}, Ref: ${paymentRef}`);
  
  // Get payment doc
  const paymentSnap = await dbNew.collection("payments").doc(paymentRef).get();
  
  if (!paymentSnap.exists) {
    console.error(`[WEBHOOK BIKE] Payment not found: ${paymentRef}`);
    return;
  }
  
  const payment = paymentSnap.data();
  
  if (payment.rentalCreated) {
    console.log(`[WEBHOOK BIKE] Already processed: ${paymentRef}`);
    return;
  }
  
  // Handle extension payment
  if (paymentType === "extension") {
    const rentalId = meta?.rentalId;
    const hours = meta?.hours || 1;
    
    if (!rentalId) {
      console.error("[WEBHOOK BIKE EXTENSION] Missing rentalId");
      return;
    }
    
    try {
      const rentalRef = dbNew.collection("rentals").doc(rentalId);
      const rentalSnap = await rentalRef.get();
      
      if (!rentalSnap.exists) {
        console.error(`[WEBHOOK BIKE EXTENSION] Rental not found: ${rentalId}`);
        return;
      }
      
      const rentalData = rentalSnap.data();
      const hourlyRate = rentalData.hourlyRate || 0;
      const extensionAmount = payment.amount;
      
      // Calculate new expected return time
      const currentExpected = rentalData.expectedReturnTime.toDate();
      const newExpectedSeconds = Math.floor(currentExpected.getTime() / 1000) + (hours * 3600);
      const newExpected = new admin.firestore.Timestamp(newExpectedSeconds, 0);
      
      // Update rental with extension
      await rentalRef.update({
        extendedHours: admin.firestore.FieldValue.increment(hours),
        extensionAmount: admin.firestore.FieldValue.increment(extensionAmount),
        expectedReturnTime: newExpected,
        status: "active",
        lastExtensionAt: admin.firestore.FieldValue.serverTimestamp(),
        lastExtensionPaymentId: paymentRef
      });
      
      // Update payment status
      await dbNew.collection("payments").doc(paymentRef).update({
        status: status,
        rentalCreated: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      console.log(`[WEBHOOK BIKE EXTENSION] ✅ Extended rental ${rentalId} by ${hours} hours`);
      return;
      
    } catch (extError) {
      console.error("[WEBHOOK BIKE EXTENSION] Error:", extError);
      return;
    }
  }
  
  // Handle late fee payment
  if (paymentType === "late_fee") {
    const rentalId = meta?.rentalId;
    
    if (!rentalId) {
      console.error("[WEBHOOK BIKE LATE_FEE] Missing rentalId");
      return;
    }
    
    try {
      const rentalRef = dbNew.collection("rentals").doc(rentalId);
      
      await rentalRef.update({
        lateFeePaid: true,
        lateFeeAmount: payment.amount,
        lateFeePaymentId: paymentRef,
        lateFeePaidAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Update payment status
      await dbNew.collection("payments").doc(paymentRef).update({
        status: status,
        rentalCreated: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      console.log(`[WEBHOOK BIKE LATE_FEE] ✅ Marked late fee as paid for ${rentalId}`);
      return;
      
    } catch (lfError) {
      console.error("[WEBHOOK BIKE LATE_FEE] Error:", lfError);
      return;
    }
  }
  
  // Handle NEW RENTAL payment
  const bikeId = meta?.bikeId;
  const durationHours = meta?.duration || 1;
  
  if (!bikeId) {
    console.error("[WEBHOOK BIKE] Missing bikeId in metadata");
    return;
  }
  
  // Get bike data AND user data outside transaction
  const bikeSnap = await dbNew.collection("bikes").doc(bikeId).get();
  const bike = bikeSnap.exists ? bikeSnap.data() : null;
  
  // ✅ NEW: Fetch user data for student verification fields
  const userSnap = await dbNew.collection("users").doc(payment.userId).get();
  const user = userSnap.exists ? userSnap.data() : null;
  
  const userName = user?.name || "";
  const studentId = user?.studentId || "";
  const studentIdPhotoUrl = user?.studentIdPhotoUrl || "";

  // Now run transaction with all data ready
  await dbNew.runTransaction(async (transaction) => {
    const paymentDoc = dbNew.collection("payments").doc(paymentRef);
    
    // Re-read payment inside transaction to ensure consistency
    const snap = await transaction.get(paymentDoc);
    const currentPayment = snap.data();
    
    if (currentPayment.rentalCreated) {
      console.log(`[WEBHOOK BIKE] Already processed (in transaction): ${paymentRef}`);
      return;
    }

    // Update payment status
    transaction.update(paymentDoc, {
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (status === "SUCCESS") {
      const rentalId = `RENTAL_${paymentRef}`;

      const now = admin.firestore.Timestamp.now();
      
      // ✅ CRITICAL: Calculate expected return time and pickup window
      const expectedReturnSeconds = now.seconds + (durationHours * 3600);
      const expectedReturn = new admin.firestore.Timestamp(expectedReturnSeconds, 0);
      
      // Pickup window ends when rental duration ends (same as expected return)
      const pickupWindowEnds = expectedReturn;

      // ✅ CRITICAL: Create COMPLETE rental document with ALL fields
      // This matches your Kotlin FirebaseRepository.kt structure exactly
      const rentalData = {
        // Basic info
        id: rentalId,
        bikeId: bikeId,
        bikeName: bike?.name || "Unknown Bike",
        userId: payment.userId,
        userName: userName,
        
        // ✅ Student verification fields (for guard display)
        studentId: studentId,
        studentIdPhotoUrl: studentIdPhotoUrl,
        studentName: userName,
        
        // Rental details
        durationHours: durationHours,
        originalDuration: durationHours,
        hourlyRate: bike?.hourlyRate || 0,
        totalAmount: payment.amount,
        
        // ✅ CRITICAL: Timing fields - ALL explicitly set
        createdAt: now,
        pickupWindowEnds: pickupWindowEnds,
        startTime: now,
        expectedReturnTime: expectedReturn,
        actualReturnTime: null,
        
        // QR Code
        qrCode: rentalId,
        status: "pending_pickup",
        
        // Payment reference
        paymentId: paymentRef,
        createdAtServer: now,
        
        // ✅ CRITICAL: Pickup tracking fields
        qrScanned: false,
        qrScannedAt: null,
        qrCodeUsed: false,
        qrCodeUsedAt: null,
        rentalTimeStarted: false,
        rentalTimeStartedAt: null,
        
        // Guard actions
        releasedBy: "",
        returnedTo: "",
        releasedAt: null,
        returnedAt: null,
        
        // Late fee tracking
        lateFeePaid: false,
        lateFeeAmount: 0.0,
        lateFeePaidAt: null,
        finalLateFeeAmount: 0.0,
        
        // Extension tracking
        extendedHours: 0,
        extensionAmount: 0.0,
        
        // Auto-return tracking
        autoReturned: false,
        autoReturnedReason: "",
        
        // Damage
        damageNotes: ""
      };

      // ✅ Create rental with ALL fields explicitly set
      transaction.set(dbNew.collection("rentals").doc(rentalId), rentalData);

      // Update bike availability
      transaction.update(dbNew.collection("bikes").doc(bikeId), {
        available: false,
      });

      // Update payment
      transaction.update(paymentDoc, { rentalCreated: true });

      console.log(`[WEBHOOK BIKE] ✅ Rental created: ${rentalId} with status=pending_pickup, qrScanned=false`);
    }
  });
}

/* ---------------------------------------------------
   HANDLE EVENT TICKET WEBHOOK (OLD FIRESTORE)
   EXACTLY as your working code - unchanged logic
--------------------------------------------------- */
async function handleEventTicketWebhook(paymentRef, status, meta) {
  await db.runTransaction(async (transaction) => {
    const paymentDoc = db.collection("payments").doc(paymentRef);

    // ✅ STEP 1: READ PAYMENT FIRST
    const snap = await transaction.get(paymentDoc);

    if (!snap.exists) {
      console.error(`[WEBHOOK] ❌ Payment not found: ${paymentRef}`);
      return;
    }

    const payment = snap.data();

    if (payment.ticketCreated) {
      console.log(`[WEBHOOK] ℹ️ Already processed: ${paymentRef}`);
      return;
    }

    // ✅ FIX: Only create ticket if payment is SUCCESS
    if (status !== "SUCCESS") {
      transaction.update(paymentDoc, {
        status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`[WEBHOOK] ℹ️ Payment failed or not successful: ${paymentRef}, status: ${status}`);
      return;
    }

    const [eventId, ticketTypeId] = payment.itemId.split("_");
    const eventRef = db.collection("events").doc(eventId);

    // ✅ STEP 2: READ EVENT BEFORE ANY WRITES
    let eventName = "Event";
    let ticketTypeName = "Ticket";
    let updatedTicketTypes = null;

    try {
      const eventSnap = await transaction.get(eventRef);
      if (eventSnap.exists) {
        const eventData = eventSnap.data();
        eventName = eventData?.title || eventData?.name || "Event";

        // Find ticket type and calculate new availability
        const ticketTypes = eventData?.ticketTypes || [];
        const ticketTypeIndex = ticketTypes.findIndex(t => t.id === ticketTypeId);

        if (ticketTypeIndex !== -1) {
          const ticketType = ticketTypes[ticketTypeIndex];
          ticketTypeName = ticketType.name || "Ticket";

          // Calculate new counts
          const currentSold = ticketType.sold || 0;
          const currentQty = ticketType.quantity || 0;
          const newSold = currentSold + 1;
          const newAvailable = Math.max(0, currentQty - newSold);

          // Prepare updated array
          updatedTicketTypes = [...ticketTypes];
          updatedTicketTypes[ticketTypeIndex] = {
            ...ticketType,
            sold: newSold,
            available: newAvailable
          };

          console.log(`[WEBHOOK] Will update ${ticketTypeName}: sold=${newSold}, available=${newAvailable}`);
        }
      }
    } catch (e) {
      console.log("[WEBHOOK] Could not fetch event details, using defaults");
    }

    const ticketId = `TICKET_${paymentRef}`;

    // ✅ STEP 3: ALL WRITES (NO READS AFTER THIS POINT)

    transaction.update(paymentDoc, {
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    transaction.set(db.collection("tickets").doc(ticketId), {
      id: ticketId,
      userId: payment.userId,
      eventId,
      eventName,
      ticketTypeId,
      ticketTypeName,
      paymentId: paymentRef,
      status: "active",
      qrCode: ticketId,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    transaction.update(paymentDoc, { ticketCreated: true });

    // Update event ticket counts if found
    if (updatedTicketTypes) {
      transaction.update(eventRef, {
        ticketTypes: updatedTicketTypes
      });
    }

    console.log(`[WEBHOOK] ✅ Ticket created: ${ticketId} for ${eventName}`);
  });
}

/* ---------------------------------------------------
   PAYMENT SUCCESS PAGE - Checks both Firestores
--------------------------------------------------- */
app.get("/payment-success", async (req, res) => {
  const reference = req.query.reference || req.query.tx_ref;

  if (!reference) {
    return res.send("<h2>❌ Invalid reference</h2>");
  }

  try {
    // Check OLD Firestore first (event tickets)
    let snap = await db.collection("payments").doc(reference).get();
    let projectType = "event_ticket";

    // If not found, check NEW Firestore (bike rentals & bus bookings)
    if (!snap.exists) {
      snap = await dbNew.collection("payments").doc(reference).get();
      const paymentData = snap.data();
      projectType = paymentData?.projectType || "bike_rental";
    }

    const payment = snap.data();

    if (!payment) {
      return res.send("<h2>Payment not found</h2>");
    }

    const isSuccess = payment?.status === "SUCCESS" || 
                      payment?.ticketCreated || 
                      payment?.rentalCreated;

    if (isSuccess) {
      let message;
      if (projectType === "bus_booking") {
        message = "Your bus seat is booked! Check your tickets.";
      } else if (projectType === "bike_rental") {
        message = "Your bike rental is confirmed!";
      } else {
        message = "Your ticket has been generated.";
      }
      
      res.send(
        `<html>
          <body style="font-family:Arial;text-align:center;padding:40px;">
            <h2 style="color:green;">✅ Payment Successful</h2>
            <p>${message}</p>
            <p>Ref: ${reference}</p>
            <button onclick="window.close()">Close</button>
          </body>
        </html>`
      );
    } else {
      res.send(
        `<html>
          <head><meta http-equiv="refresh" content="3"></head>
          <body style="text-align:center;padding:40px;">
            <h2>⏳ Processing...</h2>
            <p>Ref: ${reference}</p>
          </body>
        </html>`
      );
    }
  } catch {
    res.status(500).send("Server error");
  }
});

/* ---------------------------------------------------
   PAYMENT STATUS CHECK - Checks both Firestores
--------------------------------------------------- */
app.get("/payment-status/:id", async (req, res) => {
  try {
    // Check old Firestore first
    let snap = await db.collection("payments").doc(req.params.id).get();
    
    // If not found, check new Firestore
    if (!snap.exists) {
      snap = await dbNew.collection("payments").doc(req.params.id).get();
    }

    if (!snap.exists) return res.status(404).json({ error: "Not found" });

    const data = snap.data();
    res.json({
      status: data.status,
      ticketCreated: data.ticketCreated,
      rentalCreated: data.rentalCreated,
      amount: data.amount,
      projectType: data.projectType,
      createdAt: data.createdAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------------------------------------------------
   TICKET SCANNING (VALIDATION) - EXACTLY as your working code
--------------------------------------------------- */
app.post("/scan-ticket", async (req, res) => {
  try {
    const { qrCode, scannerId } = req.body;

    if (!qrCode) {
      return res.status(400).json({ success: false, message: "QR code required" });
    }

    console.log(`[SCAN] Attempting to scan: ${qrCode} by manager: ${scannerId}`);

    let scanResult;

    await db.runTransaction(async (transaction) => {
      const ticketRef = db.collection("tickets").doc(qrCode);
      const ticketSnap = await transaction.get(ticketRef);

      // Check if ticket exists
      if (!ticketSnap.exists) {
        console.log(`[SCAN] ❌ Ticket not found: ${qrCode}`);
        scanResult = { success: false, message: "Invalid ticket - not found" };
        return;
      }

      const ticket = ticketSnap.data();

      // ✅ MANAGER AUTHORIZATION CHECK
      // Get the event to verify the manager owns it
      const eventRef = db.collection("events").doc(ticket.eventId);
      const eventSnap = await transaction.get(eventRef);

      if (!eventSnap.exists) {
        console.log(`[SCAN] ❌ Event not found for ticket: ${qrCode}`);
        scanResult = { success: false, message: "Event not found for this ticket" };
        return;
      }

      const event = eventSnap.data();

      // Check both organizerId and organiserIds array
      const isAuthorized =
          event.organizerId === scannerId ||
          (event.organiserIds && event.organiserIds.includes(scannerId));

      if (!isAuthorized) {
        console.log(`[SCAN] ❌ User ${scannerId} not authorized for event ${ticket.eventId}`);
        scanResult = { success: false, message: "You cannot scan tickets for this event" };
        return;
      }

      // Check if already used
      if (ticket.status === "used") {
        console.log(`[SCAN] ⚠️ Already used: ${qrCode}`);
        scanResult = {
          success: false,
          message: `Ticket already used on ${ticket.usedAt?.toDate ? ticket.usedAt.toDate().toLocaleString() : "unknown date"}`
        };
        return;
      }

      // Check if ticket is active
      if (ticket.status !== "active") {
        console.log(`[SCAN] ❌ Ticket not active: ${qrCode}, status: ${ticket.status}`);
        scanResult = { success: false, message: `Ticket status: ${ticket.status}` };
        return;
      }

      // ✅ VALID - Mark as used
      transaction.update(ticketRef, {
        status: "used",
        scannedAt: admin.firestore.FieldValue.serverTimestamp(),
        scannedBy: scannerId || "organizer"
      });

      console.log(`[SCAN] ✅ Valid ticket scanned: ${qrCode} for ${ticket.eventName}`);
      scanResult = {
        success: true,
        message: `Valid: ${ticket.ticketTypeName} - ${ticket.eventName}`
      };
    });

    // ✅ Send response ONCE after transaction completes
    res.json(scanResult);

  } catch (err) {
    console.error("[SCAN ERROR]", err);
    res.status(500).json({ success: false, message: "Server error during scan" });
  }
});

/* ---------------------------------------------------
   BUS TICKET SCANNING (VALIDATION) - NEW
--------------------------------------------------- */
app.post("/scan-bus-ticket", async (req, res) => {
  try {
    const { ticketCode, scannerId } = req.body;

    if (!ticketCode) {
      return res.status(400).json({ success: false, message: "Ticket code required" });
    }

    console.log(`[SCAN BUS] Attempting to scan: ${ticketCode} by organizer: ${scannerId}`);

    // Find ticket by code
    const ticketsSnap = await dbNew.collection("bus_tickets")
      .where("ticketCode", "==", ticketCode)
      .limit(1)
      .get();

    if (ticketsSnap.empty) {
      console.log(`[SCAN BUS] ❌ Ticket not found: ${ticketCode}`);
      return res.json({ success: false, message: "Invalid ticket code" });
    }

    const ticketDoc = ticketsSnap.docs[0];
    const ticket = ticketDoc.data();

    // Check if organizer owns this bus
    if (ticket.organizerId !== scannerId) {
      console.log(`[SCAN BUS] ❌ Organizer ${scannerId} not authorized for bus ${ticket.busId}`);
      return res.json({ success: false, message: "You can only scan tickets for your own buses" });
    }

    // Check ticket status
    if (ticket.status === "USED") {
      console.log(`[SCAN BUS] ⚠️ Already used: ${ticketCode}`);
      return res.json({ 
        success: false, 
        message: `Ticket already used on ${ticket.usedAt?.toDate ? ticket.usedAt.toDate().toLocaleString() : "unknown date"}`
      });
    }

    if (ticket.status !== "VALID") {
      console.log(`[SCAN BUS] ❌ Ticket not valid: ${ticketCode}, status: ${ticket.status}`);
      return res.json({ success: false, message: `Ticket status: ${ticket.status}` });
    }

    // Mark as used
    await ticketDoc.ref.update({
      status: "USED",
      usedAt: admin.firestore.FieldValue.serverTimestamp(),
      scannedBy: scannerId
    });

    console.log(`[SCAN BUS] ✅ Valid ticket scanned: ${ticketCode} for ${ticket.studentName}`);
    res.json({
      success: true,
      message: `Valid ticket: Seat ${ticket.seatNumber} - ${ticket.studentName}`,
      ticket: {
        studentName: ticket.studentName,
        seatNumber: ticket.seatNumber,
        from: ticket.fromLocation,
        to: ticket.toLocation
      }
    });

  } catch (err) {
    console.error("[SCAN BUS ERROR]", err);
    res.status(500).json({ success: false, message: "Server error during scan" });
  }
});

/* ---------------------------------------------------
   SERVER
--------------------------------------------------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("🚀 Multi-Project Backend running on port", PORT);
  console.log("📦 Old Project: DroRide (Events/Tickets)");
  console.log("📦 New Project: Campus Bike Rental (Bikes/Rentals/Bus Bookings)");
});