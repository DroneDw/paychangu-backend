import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
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
      itemId,
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
   WEBHOOK (POST) - PAYCHANGU SERVER
--------------------------------------------------- */
app.post("/webhook", async (req, res) => {
  console.log("🔥 WEBHOOK RECEIVED");

  try {
    /* ---------------- SIGNATURE VERIFY ---------------- */
    const signature = req.headers["x-paychangu-signature"];
    const rawBody = JSON.stringify(req.body);

    const expectedSignature = crypto
      .createHmac("sha256", process.env.PAYCHANGU_WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");

    if (signature !== expectedSignature) {
      console.error("❌ Invalid webhook signature");
      return res.sendStatus(401);
    }

    /* ---------------- DATA PARSE ---------------- */
    const payload = req.body?.data || {};
    const reference =
      payload.reference ||
      payload.tx_ref ||
      payload.payment_ref;

    const status =
      payload.status === "success" ? "SUCCESS" : "FAILED";

    if (!reference) {
      console.error("❌ Missing payment reference");
      return res.sendStatus(400);
    }

    const paymentRef = db.collection("payments").doc(reference);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(paymentRef);
      if (!snap.exists) return;

      const payment = snap.data();

      tx.update(paymentRef, {
        status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      if (status !== "SUCCESS" || payment.ticketCreated) return;

      const [eventId, ticketTypeId] = payment.itemId.split("_");

      const ticketId = `TICKET_${reference}`;
      tx.set(db.collection("tickets").doc(ticketId), {
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

    console.log(`✅ Payment ${reference} processed`);
    res.sendStatus(200);
  } catch (err) {
    console.error("[WEBHOOK ERROR]", err);
    res.sendStatus(500);
  }
});

/* ---------------------------------------------------
   CALLBACK (GET) - USER REDIRECT
--------------------------------------------------- */
app.get("/webhook", async (req, res) => {
  const reference = req.query.reference || req.query.tx_ref;

  if (!reference) {
    return res.status(400).send("Invalid payment reference");
  }

  try {
    const snap = await db.collection("payments").doc(reference).get();
    if (!snap.exists) return res.status(404).send("Payment not found");

    const payment = snap.data();

    if (payment.status === "SUCCESS") {
      return res.send("Payment successful. You can return to the app.");
    }

    res.send("Payment pending. Please wait...");
  } catch (err) {
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
   SERVER START
--------------------------------------------------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
