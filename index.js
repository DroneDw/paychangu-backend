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
   WEBHOOK (POST) - Server-to-Server Notification
--------------------------------------------------- */
app.post("/webhook", async (req, res) => {
  console.log("🔥 WEBHOOK POST RECEIVED");
  console.log(JSON.stringify(req.body, null, 2));

  try {
    // 🔒 Optional but recommended: Verify webhook signature
    const signature = req.headers['x-paychangu-signature'];
    // Add signature verification logic here using PAYCHANGU_WEBHOOK_SECRET

    const payload = req.body?.data || {};
    const event = req.body?.event || "";

    const reference =
      payload.reference ||
      payload.tx_ref ||
      payload.payment_ref ||
      req.body.reference;

    const status = payload.status === "success" ? "SUCCESS" : "FAILED";

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
   CALLBACK (GET) - Browser Redirect Handler
   This handles when PayChangu redirects the user back after payment
--------------------------------------------------- */
app.get("/webhook", async (req, res) => {
  console.log("🔥 CALLBACK GET RECEIVED");
  console.log("Query params:", req.query);

  // Get reference from query params (PayChangu sends it in the URL)
  const reference = req.query.reference || req.query.tx_ref;
  const status = req.query.status || req.query.transaction_status;

  if (!reference) {
    return res.status(400).send(`
      <html>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h2 style="color: #d32f2f;">Payment Reference Missing</h2>
          <p>We couldn't verify your payment. Please check your email for confirmation.</p>
        </body>
      </html>
    `);
  }

  try {
    // Check payment status in Firestore
    const paymentDoc = await db.collection("payments").doc(reference).get();

    if (!paymentDoc.exists) {
      return res.status(404).send(`
        <html>
          <body style="font-family: Arial; text-align: center; padding: 50px;">
            <h2 style="color: #d32f2f;">Payment Not Found</h2>
            <p>Reference: ${reference}</p>
            <p>If you completed the payment, please wait a moment and check your tickets.</p>
          </body>
        </html>
      `);
    }

    const paymentData = paymentDoc.data();

    if (paymentData.status === "SUCCESS" || paymentData.ticketCreated) {
      // Success page
      res.send(`
        <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
          </head>
          <body style="font-family: Arial; text-align: center; padding: 50px; background: #f5f5f5;">
            <div style="max-width: 400px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
              <div style="font-size: 60px; color: #4caf50; margin-bottom: 20px;">✓</div>
              <h2 style="color: #4caf50; margin-top: 0;">Payment Successful!</h2>
              <p style="color: #666; font-size: 16px;">Your ticket has been created successfully.</p>
              <p style="color: #999; font-size: 14px;">Reference: ${reference}</p>
              <p style="margin-top: 30px; font-size: 14px; color: #666;">
                You can now close this page and return to the app.
              </p>
              <button onclick="window.close()" style="margin-top: 20px; padding: 12px 24px; background: #4caf50; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 16px;">
                Close Window
              </button>
            </div>
          </body>
        </html>
      `);
    } else if (status === "failed" || paymentData.status === "FAILED") {
      // Failed page
      res.send(`
        <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
          </head>
          <body style="font-family: Arial; text-align: center; padding: 50px; background: #f5f5f5;">
            <div style="max-width: 400px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
              <div style="font-size: 60px; color: #d32f2f; margin-bottom: 20px;">✗</div>
              <h2 style="color: #d32f2f; margin-top: 0;">Payment Failed</h2>
              <p style="color: #666; font-size: 16px;">We couldn't process your payment.</p>
              <p style="color: #999; font-size: 14px;">Reference: ${reference}</p>
              <p style="margin-top: 30px; font-size: 14px; color: #666;">
                Please try again in the app.
              </p>
              <button onclick="window.close()" style="margin-top: 20px; padding: 12px 24px; background: #d32f2f; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 16px;">
                Close Window
              </button>
            </div>
          </body>
        </html>
      `);
    } else {
      // Pending page
      res.send(`
        <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="refresh" content="5">
          </head>
          <body style="font-family: Arial; text-align: center; padding: 50px; background: #f5f5f5;">
            <div style="max-width: 400px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
              <div style="font-size: 40px; color: #ff9800; margin-bottom: 20px;">⏳</div>
              <h2 style="color: #ff9800; margin-top: 0;">Processing Payment...</h2>
              <p style="color: #666; font-size: 16px;">Please wait while we confirm your payment.</p>
              <p style="color: #999; font-size: 14px;">Reference: ${reference}</p>
              <p style="color: #999; font-size: 12px; margin-top: 20px;">This page will refresh automatically...</p>
            </div>
          </body>
        </html>
      `);
    }
  } catch (err) {
    console.error("[CALLBACK ERROR]", err);
    res.status(500).send("Internal Server Error");
  }
});

/* ---------------------------------------------------
   PAYMENT STATUS CHECK
--------------------------------------------------- */
app.get("/payment-status/:id", async (req, res) => {
  try {
    const snap = await db.collection("payments").doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: "Payment not found" });
    res.json(snap.data());
  } catch (err) {
    console.error("[STATUS CHECK ERROR]", err);
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