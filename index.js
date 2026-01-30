import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import { db, admin } from "./firebaseAdmin.js";

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
   WEBHOOK (POST) - No signature check for now
--------------------------------------------------- */
app.post("/webhook", async (req, res) => {
  console.log("🔥 WEBHOOK RECEIVED");

  try {
    // Extract data from PayChangu payload (root level)
    const payload = req.body;
    const reference = payload.tx_ref || payload.reference;
    const status = payload.status === "success" ? "SUCCESS" : "FAILED";

    console.log(`Reference: ${reference}, Status: ${status}`);

    if (!reference) {
      console.error("❌ Missing reference. Payload:", JSON.stringify(payload));
      return res.sendStatus(400);
    }

    const paymentRef = db.collection("payments").doc(reference);
    const snap = await paymentRef.get();

    if (!snap.exists) {
      console.log("⚠️ Payment not found in DB:", reference);
      return res.sendStatus(200); // Acknowledge to stop retries
    }

    const payment = snap.data();

    // Update status
    await paymentRef.update({
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Create ticket only if success and not already created
    if (status === "SUCCESS" && !payment.ticketCreated) {
      const [eventId, ticketTypeId] = payment.itemId.split("_");
      const ticketId = `TICKET_${reference}`;

      await db.collection("tickets").doc(ticketId).set({
        id: ticketId,
        userId: payment.userId,
        eventId,
        ticketTypeId,
        paymentId: reference,
        status: "active",
        qrCode: ticketId,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      await paymentRef.update({ ticketCreated: true });
      console.log(`✅ Ticket created: ${ticketId}`);
    } else {
      console.log(`ℹ️ Skipped: status=${status}, alreadyCreated=${payment.ticketCreated}`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("[WEBHOOK ERROR]", err);
    res.sendStatus(500);
  }
});

/* ---------------------------------------------------
   PAYMENT SUCCESS (GET) - User redirect page
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
          <head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
          <body style="font-family: Arial; text-align: center; padding: 50px; background: #f5f5f5;">
            <div style="max-width: 400px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
              <div style="font-size: 60px; color: #4caf50; margin-bottom: 20px;">✓</div>
              <h2 style="color: #4caf50; margin-top: 0;">Payment Successful!</h2>
              <p style="color: #666;">Your ticket has been generated.</p>
              <p style="color: #999; font-size: 14px;">Ref: ${reference}</p>
              <button onclick="window.close()" style="margin-top: 20px; padding: 12px 24px; background: #4caf50; color: white; border: none; border-radius: 5px; cursor: pointer;">Close</button>
            </div>
          </body>
        </html>
      `);
    } else {
      // Auto-refresh page every 3 seconds until payment is processed
      res.send(`
        <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="refresh" content="3">
          </head>
          <body style="text-align: center; padding: 50px;">
            <h2>⏳ Processing...</h2>
            <p>Checking payment status...</p>
            <p style="color: #999;">Ref: ${reference}</p>
          </body>
        </html>
      `);
    }
  } catch (err) {
    res.status(500).send("Server Error");
  }
});

/* ---------------------------------------------------
   STATUS CHECK (for app polling)
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

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});