import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import admin from "firebase-admin";
import { db } from "./firebaseAdmin.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

/* ---------------------------------------------------
   PAY INIT
--------------------------------------------------- */
app.post("/pay", async (req, res) => {
  try {
    const { amount, phone, network, userId, itemId } = req.body;

    if (!amount || !phone || !network || !userId || !itemId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const paymentRef = `PAY_${Date.now()}`;

    const payResponse = await axios.post(
      "https://api.paychangu.com/payment",
      {
        amount,
        currency: "MWK",
        phone_number: phone,
        network,
        reference: paymentRef,
        callback_url: "https://paychangu-backend-g9vt.onrender.com/webhook"
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
      userId,
      itemId,               // eventId_ticketTypeId
      amount,
      phone,
      network,
      status: "PENDING",
      ticketCreated: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ paymentId: paymentRef, checkoutUrl });
  } catch (err) {
    console.error("[PAY ERROR]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ---------------------------------------------------
   WEBHOOK (PAYMENT CONFIRMATION + TICKET CREATION)
--------------------------------------------------- */
app.post("/webhook", async (req, res) => {
  console.log("🔥 WEBHOOK RECEIVED");
  console.log(JSON.stringify(req.body, null, 2));

  try {
    const payload = req.body?.data || {};
    const event = req.body?.event || "";

    const reference =
      payload.reference ||
      payload.tx_ref ||
      payload.payment_ref ||
      req.body.reference;

    const status =
      payload.status ||
      (event.toLowerCase().includes("success") ? "SUCCESS" : null);

    if (!reference || !status) {
      console.error("[WEBHOOK] Missing reference or status");
      return res.sendStatus(400);
    }

    const paymentRef = db.collection("payments").doc(reference);

    await db.runTransaction(async (tx) => {
      const paymentSnap = await tx.get(paymentRef);
      if (!paymentSnap.exists) return;

      const payment = paymentSnap.data();

      // Always update payment status
      tx.update(paymentRef, {
        status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // STOP if already processed or not successful
      if (status !== "SUCCESS" || payment.ticketCreated) return;

      const [eventId, ticketTypeId] = payment.itemId.split("_");

      // Create ticket
      const ticketId = `TICKET_${reference}`;
      const ticketRef = db.collection("tickets").doc(ticketId);

      tx.set(ticketRef, {
        id: ticketId,
        userId: payment.userId,
        eventId,
        ticketTypeId,
        paymentId: reference,
        status: "active",
        qrCode: ticketId,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      tx.update(paymentRef, { ticketCreated: true });
    });

    console.log(`[WEBHOOK] Payment ${reference} processed successfully`);
    res.sendStatus(200);
  } catch (err) {
    console.error("[WEBHOOK ERROR]", err.message);
    res.sendStatus(500);
  }
});

/* ---------------------------------------------------
   PAYMENT STATUS CHECK
--------------------------------------------------- */
app.get("/payment-status/:id", async (req, res) => {
  const snap = await db.collection("payments").doc(req.params.id).get();
  if (!snap.exists) return res.sendStatus(404);
  res.json(snap.data());
});

/* ---------------------------------------------------
   SERVER START
--------------------------------------------------- */
app.listen(process.env.PORT, () => {
  console.log("🚀 Server running on port", process.env.PORT);
});
