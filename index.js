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
      "https://api.paychangu.com/payment",
      {
        amount,
        currency: "MWK",
        phone_number: phone,
        network,
        reference: paymentRef,
        callback_url: `${process.env.BACKEND_URL}/webhook`,
        meta: { userId, itemId } // ✅ include metadata
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYCHANGU_SECRET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const checkoutUrl = payResponse?.data?.data?.checkout_url;
    if (!checkoutUrl) throw new Error("Checkout URL missing from PayChangu");

    // Store payment in Firestore
    await db.collection("payments").doc(paymentRef).set({
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
    console.error("[PAY ERROR]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ---------------------------------------------------
   WEBHOOK
--------------------------------------------------- */
app.post("/webhook", async (req, res) => {
  console.log("[WEBHOOK] Received");

  try {
    const signature = req.headers["x-paychangu-signature"];
    const webhookSecret = process.env.PAYCHANGU_WEBHOOK_SECRET;

    if (webhookSecret && signature) {
      const expectedSignature = crypto
        .createHmac("sha256", webhookSecret)
        .update(req.rawBody)
        .digest("hex");

      if (signature !== expectedSignature) {
        console.error("[WEBHOOK] ❌ Invalid signature");
        return res.sendStatus(401);
      }
      console.log("[WEBHOOK] ✅ Signature verified");
    } else {
      console.log("[WEBHOOK] ℹ️ No signature provided by PayChangu");
    }

    const payload = req.body;
    const reference = payload.tx_ref || payload.reference;
    const status = payload.status === "success" ? "SUCCESS" : "FAILED";

    if (!reference) {
      console.error("[WEBHOOK] ❌ Missing reference");
      return res.sendStatus(400);
    }

    console.log(`[WEBHOOK] Ref=${reference} Status=${status}`);

    await db.runTransaction(async (transaction) => {
      const paymentDoc = db.collection("payments").doc(reference);
      const snap = await transaction.get(paymentDoc);

      let payment;

      // ✅ Create payment if missing
      if (!snap.exists) {
        console.log(`[WEBHOOK] ℹ️ Creating missing payment ${reference}`);
        payment = {
          userId: payload.meta?.userId,
          itemId: payload.meta?.itemId,
          amount: payload.amount || 0,
          status,
          ticketCreated: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        };

        if (!payment.userId || !payment.itemId) {
          console.error("[WEBHOOK] ❌ Missing userId or itemId in metadata");
          return;
        }

        transaction.set(paymentDoc, payment);
      } else {
        payment = snap.data();
      }

      // ✅ Idempotency: stop if ticket already created
      if (payment.ticketCreated) {
        console.log(`[WEBHOOK] ℹ️ Already processed: ${reference}`);
        return;
      }

      // Update payment status
      transaction.update(paymentDoc, {
        status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // ✅ Create ticket if payment successful
      if (status === "SUCCESS") {
        const [eventId, ticketTypeId] = payment.itemId.split("_");
        const ticketId = `TICKET_${reference}`;

        transaction.set(db.collection("tickets").doc(ticketId), {
          id: ticketId,
          userId: payment.userId,
          eventId,
          ticketTypeId,
          paymentId: reference,
          status: "active",
          qrCode: ticketId,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        transaction.update(paymentDoc, { ticketCreated: true });
        console.log(`[WEBHOOK] ✅ Ticket created: ${ticketId}`);
      } else {
        console.log(`[WEBHOOK] ❌ Payment failed: ${reference}`);
      }
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

  if (!reference) return res.send("<h2>❌ Invalid reference</h2>");

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
   HEALTH CHECK
--------------------------------------------------- */
app.get("/", (req, res) => res.send("PayChangu Backend Running"));

/* ---------------------------------------------------
   SERVER
--------------------------------------------------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
