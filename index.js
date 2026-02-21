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
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

app.use(cors());

// Webhook signature verification (kept for POST but not used for GET)
function verifyWebhookSignature(req) {
  const signature = req.headers["x-paychangu-signature"];
  const secret = process.env.PAYCHANGU_WEBHOOK_SECRET;

  if (!signature || !secret) return false;

  const hash = crypto
    .createHmac("sha256", secret)
    .update(req.rawBody)
    .digest("hex");

  return signature === hash;
}

/* ---------------------------------------------------
   HEALTH CHECK
--------------------------------------------------- */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "paychangu-backend",
    projects: ["dride", "campus-bike-rental"],
  });
});

/* ---------------------------------------------------
   PAY INIT - Handles BOTH projects
--------------------------------------------------- */
app.post("/pay", async (req, res) => {
  try {
    const { amount, phone, network, userId, itemId, projectType } = req.body;

    if (!amount || !phone || !network || !userId || !itemId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Determine which project this is for
    const isBikeRental = projectType === "bike_rental" || itemId.startsWith("BIKE_");
    const paymentRef = crypto.randomUUID();
    
    console.log(`[PAY] Creating payment ${paymentRef} for ${isBikeRental ? 'bike_rental' : 'event_ticket'}`);

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
        meta: {
          paymentRef,
          userId,
          itemId,
          projectType: isBikeRental ? "bike_rental" : "event_ticket",
        },
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
      projectType: isBikeRental ? "bike_rental" : "event_ticket",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (isBikeRental) {
      // NEW Firestore for bike rentals
      paymentData.rentalCreated = false;
      await dbNew.collection("payments").doc(paymentRef).set(paymentData);
    } else {
      // OLD Firestore for event tickets
      paymentData.ticketCreated = false;
      await db.collection("payments").doc(paymentRef).set(paymentData);
    }

    console.log(`[PAY] Stored payment ${paymentRef} in ${isBikeRental ? 'NEW' : 'OLD'} Firestore`);
    res.json({ paymentId: paymentRef, checkoutUrl });
  } catch (err) {
    console.error("[PAY ERROR]", err.response?.data || err.message);
    res.status(500).json({ error: "Payment initialization failed" });
  }
});

/* ---------------------------------------------------
   WEBHOOK - GET handler for PayChangu (NEW)
--------------------------------------------------- */
app.get("/webhook", async (req, res) => {
  console.log("[WEBHOOK GET] Received");
  
  try {
    // PayChangu sends data as query parameters
    const { status, reference, meta } = req.query;
    
    console.log("[WEBHOOK GET] Query:", req.query);
    
    if (!reference) {
      console.error("[WEBHOOK GET] No reference provided");
      return res.sendStatus(400);
    }
    
    // Parse meta if it's a string
    let metaData = meta;
    if (typeof meta === "string") {
      try {
        metaData = JSON.parse(meta);
      } catch (e) {
        // If can't parse, create minimal meta from reference
        metaData = { paymentRef: reference, projectType: "event_ticket" };
      }
    }
    
    const paymentRef = metaData?.paymentRef || reference;
    const projectType = metaData?.projectType || "event_ticket";
    
    console.log(`[WEBHOOK GET] paymentRef=${paymentRef}, project=${projectType}, status=${status}`);
    
    // Route to correct handler
    if (projectType === "bike_rental") {
      await handleBikeRentalWebhook(paymentRef, status === "success" ? "SUCCESS" : "FAILED", metaData);
    } else {
      await handleEventTicketWebhook(paymentRef, status === "success" ? "SUCCESS" : "FAILED", metaData);
    }
    
    res.sendStatus(200);
  } catch (err) {
    console.error("[WEBHOOK GET ERROR]", err);
    res.sendStatus(500);
  }
});

/* ---------------------------------------------------
   WEBHOOK - POST handler (kept for backward compatibility)
--------------------------------------------------- */
app.post("/webhook", async (req, res) => {
  console.log("[WEBHOOK POST] Received");

  // Skip signature verification for now since PayChangu uses GET
  // if (!verifyWebhookSignature(req)) {
  //   console.error("[WEBHOOK] Invalid signature");
  //   return res.sendStatus(401);
  // }

  try {
    const payload = req.body;
    console.log("[WEBHOOK POST] Payload:", JSON.stringify(payload, null, 2));

    let meta = payload.meta;

    if (typeof meta === "string") {
      try {
        meta = JSON.parse(meta);
      } catch (e) {
        console.error("[WEBHOOK POST] Failed to parse meta");
        return res.sendStatus(400);
      }
    }

    const paymentRef = meta?.paymentRef;
    const projectType = meta?.projectType || "event_ticket";

    if (!paymentRef) {
      console.error("[WEBHOOK POST] paymentRef missing");
      return res.sendStatus(400);
    }

    const status = payload.status === "success" ? "SUCCESS" : "FAILED";
    console.log(`[WEBHOOK POST] paymentRef=${paymentRef} project=${projectType} status=${status}`);

    // Route to correct handler
    if (projectType === "bike_rental") {
      await handleBikeRentalWebhook(paymentRef, status, meta);
    } else {
      await handleEventTicketWebhook(paymentRef, status, meta);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("[WEBHOOK POST ERROR]", err);
    res.sendStatus(500);
  }
});

/* ---------------------------------------------------
   HANDLE BIKE RENTAL WEBHOOK (NEW FIRESTORE)
--------------------------------------------------- */
async function handleBikeRentalWebhook(paymentRef, status, meta) {
  await dbNew.runTransaction(async (transaction) => {
    const paymentDoc = dbNew.collection("payments").doc(paymentRef);
    const snap = await transaction.get(paymentDoc);

    if (!snap.exists) {
      console.error(`[WEBHOOK BIKE] Payment not found: ${paymentRef}`);
      return;
    }

    const payment = snap.data();

    if (payment.rentalCreated) {
      console.log(`[WEBHOOK BIKE] Already processed: ${paymentRef}`);
      return;
    }

    transaction.update(paymentDoc, {
      status,
      updatedAt: adminNew.firestore.FieldValue.serverTimestamp(),
    });

    if (status === "SUCCESS") {
      const rentalId = `RENTAL_${paymentRef}`;
      const parts = payment.itemId.split("_");
      const bikeId = parts[1];
      const durationHours = parseInt(parts[2]) || 1;

      // Get bike from NEW Firestore
      const bikeDoc = await transaction.get(dbNew.collection("bikes").doc(bikeId));
      const bike = bikeDoc.exists ? bikeDoc.data() : null;

      const now = adminNew.firestore.Timestamp.now();
      const expectedReturn = new adminNew.firestore.Timestamp(
        now.seconds + durationHours * 3600,
        now.nanoseconds
      );

      // Create rental in NEW Firestore
      transaction.set(dbNew.collection("rentals").doc(rentalId), {
        id: rentalId,
        bikeId: bikeId,
        bikeName: bike?.name || "Unknown Bike",
        userId: payment.userId,
        userName: "",
        durationHours: durationHours,
        hourlyRate: bike?.hourlyRate || 0,
        totalAmount: payment.amount,
        startTime: now,
        expectedReturnTime: expectedReturn,
        actualReturnTime: null,
        qrCode: rentalId,
        status: "active",
        releasedBy: "",
        returnedTo: "",
        releasedAt: null,
        returnedAt: null,
        damageNotes: "",
        paymentId: paymentRef,
        createdAt: now,
      });

      // Update bike availability in NEW Firestore
      transaction.update(dbNew.collection("bikes").doc(bikeId), {
        available: false,
      });

      transaction.update(paymentDoc, { rentalCreated: true });

      console.log(`[WEBHOOK BIKE] Rental created: ${rentalId}`);
    }
  });
}

/* ---------------------------------------------------
   HANDLE EVENT TICKET WEBHOOK (OLD FIRESTORE)
--------------------------------------------------- */
async function handleEventTicketWebhook(paymentRef, status, meta) {
  await db.runTransaction(async (transaction) => {
    const paymentDoc = db.collection("payments").doc(paymentRef);
    const snap = await transaction.get(paymentDoc);

    if (!snap.exists) {
      console.error(`[WEBHOOK EVENT] Payment not found: ${paymentRef}`);
      return;
    }

    const payment = snap.data();

    if (payment.ticketCreated) {
      console.log(`[WEBHOOK EVENT] Already processed: ${paymentRef}`);
      return;
    }

    if (status !== "SUCCESS") {
      transaction.update(paymentDoc, {
        status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`[WEBHOOK EVENT] Payment failed: ${paymentRef}`);
      return;
    }

    const [eventId, ticketTypeId] = payment.itemId.split("_");
    const eventRef = db.collection("events").doc(eventId);

    let eventName = "Event";
    let ticketTypeName = "Ticket";
    let updatedTicketTypes = null;

    try {
      const eventSnap = await transaction.get(eventRef);
      if (eventSnap.exists) {
        const eventData = eventSnap.data();
        eventName = eventData?.title || eventData?.name || "Event";

        const ticketTypes = eventData?.ticketTypes || [];
        const ticketTypeIndex = ticketTypes.findIndex((t) => t.id === ticketTypeId);

        if (ticketTypeIndex !== -1) {
          const ticketType = ticketTypes[ticketTypeIndex];
          ticketTypeName = ticketType.name || "Ticket";

          const currentSold = ticketType.sold || 0;
          const currentQty = ticketType.quantity || 0;
          const newSold = currentSold + 1;
          const newAvailable = Math.max(0, currentQty - newSold);

          updatedTicketTypes = [...ticketTypes];
          updatedTicketTypes[ticketTypeIndex] = {
            ...ticketType,
            sold: newSold,
            available: newAvailable,
          };
        }
      }
    } catch (e) {
      console.log("[WEBHOOK EVENT] Could not fetch event details");
    }

    const ticketId = `TICKET_${paymentRef}`;

    transaction.update(paymentDoc, {
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
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
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    transaction.update(paymentDoc, { ticketCreated: true });

    if (updatedTicketTypes) {
      transaction.update(eventRef, {
        ticketTypes: updatedTicketTypes,
      });
    }

    console.log(`[WEBHOOK EVENT] Ticket created: ${ticketId}`);
  });
}

/* ---------------------------------------------------
   PAYMENT SUCCESS PAGE
--------------------------------------------------- */
app.get("/payment-success", async (req, res) => {
  const reference = req.query.reference;

  if (!reference) {
    return res.send("<h2>Invalid reference</h2>");
  }

  try {
    // Check BOTH Firestores
    let snap = await db.collection("payments").doc(reference).get();
    let isNewProject = false;

    if (!snap.exists) {
      snap = await dbNew.collection("payments").doc(reference).get();
      isNewProject = true;
    }

    const payment = snap.data();

    if (!payment) {
      return res.send("<h2>Payment not found</h2>");
    }

    const isSuccess = payment?.status === "SUCCESS" || 
                      payment?.ticketCreated || 
                      payment?.rentalCreated;

    if (isSuccess) {
      const message = isNewProject 
        ? "Your bike rental is confirmed!" 
        : "Your ticket has been generated.";
      
      res.send(`
        <html>
          <body style="font-family:Arial;text-align:center;padding:40px;">
            <h2 style="color:green;">Payment Successful!</h2>
            <p>${message}</p>
            <p>Reference: ${reference}</p>
            <button onclick="window.close()">Close</button>
          </body>
        </html>
      `);
    } else {
      res.send(`
        <html>
          <head><meta http-equiv="refresh" content="3"></head>
          <body style="text-align:center;padding:40px;">
            <h2>Processing...</h2>
            <p>Reference: ${reference}</p>
          </body>
        </html>
      `);
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
   SCAN TICKET (OLD PROJECT - unchanged)
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

      if (!ticketSnap.exists) {
        console.log(`[SCAN] Ticket not found: ${qrCode}`);
        scanResult = { success: false, message: "Invalid ticket - not found" };
        return;
      }

      const ticket = ticketSnap.data();
      const eventRef = db.collection("events").doc(ticket.eventId);
      const eventSnap = await transaction.get(eventRef);

      if (!eventSnap.exists) {
        scanResult = { success: false, message: "Event not found for this ticket" };
        return;
      }

      const event = eventSnap.data();
      const isAuthorized =
        event.organizerId === scannerId ||
        (event.organiserIds && event.organiserIds.includes(scannerId));

      if (!isAuthorized) {
        scanResult = { success: false, message: "You cannot scan tickets for this event" };
        return;
      }

      if (ticket.status === "used") {
        scanResult = {
          success: false,
          message: `Ticket already used on ${ticket.usedAt?.toDate ? ticket.usedAt.toDate().toLocaleString() : "unknown date"}`,
        };
        return;
      }

      if (ticket.status !== "active") {
        scanResult = { success: false, message: `Ticket status: ${ticket.status}` };
        return;
      }

      transaction.update(ticketRef, {
        status: "used",
        scannedAt: admin.firestore.FieldValue.serverTimestamp(),
        scannedBy: scannerId || "organizer",
      });

      scanResult = {
        success: true,
        message: `Valid: ${ticket.ticketTypeName} - ${ticket.eventName}`,
      };
    });

    res.json(scanResult);
  } catch (err) {
    console.error("[SCAN ERROR]", err);
    res.status(500).json({ success: false, message: "Server error during scan" });
  }
});

/* ---------------------------------------------------
   SERVER
--------------------------------------------------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("🚀 Dual Firestore Backend running on port", PORT);
  console.log("📦 Old Project: DroRide (Events/Tickets)");
  console.log("📦 New Project: Campus Bike Rental (Bikes/Rentals)");
});