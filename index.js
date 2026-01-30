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
   PAY INIT - Creates payment and returns checkout URL
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
        // ✅ FIXED: This is where the USER is redirected after payment (browser GET)
        callback_url: "https://paychangu-backend-g9vt.onrender.com/payment-success"
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
   WEBHOOK (POST) - PAYCHANGU SERVER → YOUR SERVER
   This creates the ticket. User never sees this URL.
--------------------------------------------------- */
app.post("/webhook", async (req, res) => {
  console.log("🔥 WEBHOOK POST RECEIVED");

  try {
    /* -------- VERIFY SIGNATURE (Security) -------- */
    const signature = req.headers["x-paychangu-signature"];
    const rawBody = JSON.stringify(req.body);

    // Only verify if webhook secret is configured
    if (process.env.PAYCHANGU_WEBHOOK_SECRET) {
      const expectedSignature = crypto
        .createHmac("sha256", process.env.PAYCHANGU_WEBHOOK_SECRET)
        .update(rawBody)
        .digest("hex");

      if (signature !== expectedSignature) {
        console.error("❌ Invalid webhook signature");
        return res.sendStatus(401);
      }
    }

    /* -------- PROCESS PAYMENT -------- */
    const payload = req.body?.data || {};
    const reference = payload.reference || payload.tx_ref || payload.payment_ref;
    const status = payload.status === "success" ? "SUCCESS" : "FAILED";

    if (!reference) {
      console.error("❌ Missing payment reference");
      return res.sendStatus(400);
    }

    const paymentRef = db.collection("payments").doc(reference);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(paymentRef);
      if (!snap.exists) return;

      const payment = snap.data();

      // Update status
      tx.update(paymentRef, {
        status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Only create ticket if successful and not already created
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

    console.log(`✅ Payment ${reference} processed successfully`);
    res.sendStatus(200);
  } catch (err) {
    console.error("[WEBHOOK ERROR]", err);
    res.sendStatus(500);
  }
});

/* ---------------------------------------------------
   PAYMENT SUCCESS (GET) - USER BROWSER REDIRECT
   This shows the success page to user. No ticket logic here.
--------------------------------------------------- */
app.get("/payment-success", async (req, res) => {
  const reference = req.query.reference || req.query.tx_ref;

  if (!reference) {
    return res.status(400).send(`
      <html>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h2 style="color: #d32f2f;">Invalid Reference</h2>
          <p>Missing payment reference.</p>
        </body>
      </html>
    `);
  }

  try {
    // Check Firestore to show correct status
    const snap = await db.collection("payments").doc(reference).get();
    const payment = snap.data();

    if (payment?.status === "SUCCESS" || payment?.ticketCreated) {
      return res.send(`
        <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
          </head>
          <body style="font-family: Arial; text-align: center; padding: 50px; background: #f5f5f5;">
            <div style="max-width: 400px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
              <div style="font-size: 60px; color: #4caf50; margin-bottom: 20px;">✓</div>
              <h2 style="color: #4caf50; margin-top: 0;">Payment Successful!</h2>
              <p style="color: #666; font-size: 16px;">Your ticket has been generated.</p>
              <p style="color: #999; font-size: 14px;">Ref: ${reference}</p>
              <p style="margin-top: 30px; font-size: 14px; color: #666;">
                You can now close this page and return to the app.
              </p>
            </div>
          </body>
        </html>
      `);
    } else {
      // Pending or not found
      return res.send(`
        <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="refresh" content="5">
          </head>
          <body style="font-family: Arial; text-align: center; padding: 50px; background: #f5f5f5;">
            <div style="max-width: 400px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px;">
              <div style="font-size: 40px; color: #ff9800; margin-bottom: 20px;">⏳</div>
              <h2 style="color: #ff9800; margin-top: 0;">Processing...</h2>
              <p style="color: #666;">Confirming your payment.</p>
              <p style="color: #999; font-size: 12px;">This page refreshes automatically...</p>
            </div>
          </body>
        </html>
      `);
    }
  } catch (err) {
    console.error("[SUCCESS PAGE ERROR]", err);
    res.status(500).send("Server Error");
  }
});

/* ---------------------------------------------------
   PAYMENT STATUS CHECK (for app polling)
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