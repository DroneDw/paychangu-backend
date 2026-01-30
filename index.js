import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import { db, admin } from "./firebaseAdmin.js";

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
   PAY INIT
--------------------------------------------------- */
app.post("/pay", async (req, res) => {
  try {
    const { amount, phone, network, userId, itemId } = req.body;

    if (!amount || !phone || !network || !userId || !itemId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const paymentRef = crypto.randomUUID();
    console.log(`[PAY] Creating payment ${paymentRef}`);

    const payResponse = await axios.post(
      "https://api.paychangu.com/payment  ",
      {
        amount,
        currency: "MWK",
        phone_number: phone,
        network,
        reference: paymentRef,
        callback_url: "https://paychangu-backend-g9vt.onrender.com/payment-success  ",

        // ✅ SINGLE SOURCE OF TRUTH
        meta: {
          paymentRef,
          userId,
          itemId
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYCHANGU_SECRET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const checkoutUrl = payResponse?.data?.data?.checkout_url;
    if (!checkoutUrl) {
      throw new Error("Checkout URL missing from PayChangu");
    }

    await db.collection("payments").doc(paymentRef).set({
      id: paymentRef,
      userId,
      itemId,
      amount,
      phone,
      network,
      status: "PENDING",
      ticketCreated: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`[PAY] Stored payment ${paymentRef}`);
    res.json({ paymentId: paymentRef, checkoutUrl });
  } catch (err) {
    console.error("[PAY ERROR]", err.response?.data || err.message);
    res.status(500).json({ error: "Payment initialization failed" });
  }
});

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

    if (!paymentRef) {
      console.error("[WEBHOOK] ❌ paymentRef missing after parsing meta");
      return res.sendStatus(400);
    }

    const status =
      payload.status === "success" ? "SUCCESS" : "FAILED";

    console.log(`[WEBHOOK] paymentRef=${paymentRef} status=${status}`);

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

      const [eventId, ticketTypeId] = payment.itemId.split("_");
      const eventRef = db.collection("events_balaka").doc(eventId);

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
        eventName,        // ✅ Human-readable event name
        ticketTypeId,
        ticketTypeName,   // ✅ Human-readable ticket type name
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

    res.sendStatus(200);
  } catch (err) {
    console.error("[WEBHOOK ERROR]", err);
    res.sendStatus(500);
  }
});

/* ---------------------------------------------------
   PAYMENT SUCCESS PAGE
--------------------------------------------------- */
app.get("/payment-success", async (req, res) => {
  const reference = req.query.reference || req.query.tx_ref;

  if (!reference) {
    return res.send("<h2>❌ Invalid reference</h2>");
  }

  try {
    const snap = await db.collection("payments").doc(reference).get();
    const payment = snap.data();

    if (payment?.status === "SUCCESS" || payment?.ticketCreated) {
      res.send(`
        <html>
          <body style="font-family:Arial;text-align:center;padding:40px;">
            <h2 style="color:green;">✅ Payment Successful</h2>
            <p>Your ticket has been generated.</p>
            <p>Ref: ${reference}</p>
            <button onclick="window.close()">Close</button>
          </body>
        </html>
      `);
    } else {
      res.send(`
        <html>
          <head><meta http-equiv="refresh" content="3"></head>
          <body style="text-align:center;padding:40px;">
            <h2>⏳ Processing...</h2>
            <p>Ref: ${reference}</p>
          </body>
        </html>
      `);
    }
  } catch {
    res.status(500).send("Server error");
  }
});

/* ---------------------------------------------------
   PAYMENT STATUS CHECK
--------------------------------------------------- */
app.get("/payment-status/:id", async (req, res) => {
  try {
    const snap = await db.collection("payments").doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: "Not found" });
    res.json(snap.data());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------------------------------------------------
   TICKET SCANNING (VALIDATION)
--------------------------------------------------- */
app.post("/scan-ticket", async (req, res) => {
  try {
    const { qrCode } = req.body;

    if (!qrCode) {
      return res.status(400).json({ success: false, message: "QR code required" });
    }

    console.log(`[SCAN] Attempting to scan: ${qrCode}`);

    await db.runTransaction(async (transaction) => {
      const ticketRef = db.collection("tickets").doc(qrCode);
      const ticketSnap = await transaction.get(ticketRef);

      // Check if ticket exists
      if (!ticketSnap.exists) {
        console.log(`[SCAN] ❌ Ticket not found: ${qrCode}`);
        return res.json({ success: false, message: "Invalid ticket - not found" });
      }

      const ticket = ticketSnap.data();

      // Check if already used
      if (ticket.status === "used") {
        console.log(`[SCAN] ⚠️ Already used: ${qrCode}`);
        return res.json({
          success: false,
          message: `Ticket already used on ${ticket.usedAt?.toDate() || "unknown date"}`
        });
      }

      // Check if ticket is active
      if (ticket.status !== "active") {
        console.log(`[SCAN] ❌ Ticket not active: ${qrCode}, status: ${ticket.status}`);
        return res.json({ success: false, message: `Ticket status: ${ticket.status}` });
      }

      // ✅ VALID - Mark as used
      transaction.update(ticketRef, {
        status: "used",
        scannedAt: admin.firestore.FieldValue.serverTimestamp(),
        scannedBy: req.body.scannerId || "organizer" // optional: track who scanned
      });

      console.log(`[SCAN] ✅ Valid ticket scanned: ${qrCode} for ${ticket.eventName}`);
      return res.json({
        success: true,
        message: `Valid: ${ticket.ticketTypeName} - ${ticket.eventName}`
      });
    });

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
  console.log("🚀 Server running on port", PORT);
});