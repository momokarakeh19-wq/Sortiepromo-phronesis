require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Resend } = require("resend");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const EVENT_NAME = "Sortie de la Promotion Phronesis 2025/2026";
const TICKET_PRICE = 3000;
const SENEPAY_API_KEY   = process.env.SENEPAY_API_KEY;
const SENEPAY_API_SECRET = process.env.SENEPAY_API_SECRET;
const RESEND_API_KEY    = process.env.RESEND_API_KEY;
const SENDER_EMAIL      = process.env.SENDER_EMAIL || "onboarding@resend.dev";
const BASE_URL          = process.env.BASE_URL || "http://localhost:3000";

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
const orders = {};

// ── 1. Créer une session de paiement SenePay ──────────────────────────────────
app.post("/api/create-payment", async (req, res) => {
  try {
    const { firstName, lastName, email, quantity } = req.body;
    if (!firstName || !lastName || !email || !quantity)
      return res.status(400).json({ error: "Tous les champs sont obligatoires." });

    const qty = parseInt(quantity, 10);
    if (!qty || qty < 1 || qty > 10)
      return res.status(400).json({ error: "Nombre de tickets invalide (max 10)." });

    const ref   = "PHRO-" + crypto.randomBytes(5).toString("hex").toUpperCase();
    const amount = TICKET_PRICE * qty;

    orders[ref] = { firstName, lastName, email, quantity: qty, amount, status: "pending" };

    if (!SENEPAY_API_KEY || !SENEPAY_API_SECRET)
      return res.status(500).json({ error: "Clés API manquantes. Contacte l'administrateur." });

    // Appel API SenePay — création d'un paiement (payin)
    const response = await axios.post(
      "https://api.sene-pay.com/api/v1/payin",
      {
        amount,
        currency: "XOF",
        order_id: ref,
        description: `${qty} ticket(s) - ${EVENT_NAME}`,
        callback_url: `${BASE_URL}/api/webhooks/senepay`,
        return_url:   `${BASE_URL}/success.html?ref=${ref}`,
        cancel_url:   `${BASE_URL}/?cancelled=1`,
        customer: { name: `${firstName} ${lastName}`, email }
      },
      {
        headers: {
          "Content-Type":  "application/json",
          "X-Api-Key":     SENEPAY_API_KEY,
          "X-Api-Secret":  SENEPAY_API_SECRET,
        },
      }
    );

    const data = response.data;
    const checkoutUrl = data.payment_url || data.checkout_url || data.url || data.redirect_url;

    if (!checkoutUrl)
      return res.status(500).json({ error: "Réponse API SenePay invalide.", raw: data });

    res.json({ checkoutUrl });
  } catch (err) {
    console.error("Erreur SenePay:", err.response?.data || err.message);
    res.status(500).json({
      error: "Impossible de créer le paiement.",
      detail: err.response?.data || err.message
    });
  }
});

// ── 2. Webhook SenePay (confirmation paiement) ────────────────────────────────
app.post("/api/webhooks/senepay", async (req, res) => {
  res.status(200).json({ received: true });
  try {
    const payload = req.body;
    const ref = payload.order_id || payload.orderReference || payload.reference;
    const order = orders[ref];
    if (!order || order.status === "paid") return;
    const status = payload.status || payload.event || "";
    if (!["paid","completed","success","checkout.session.completed"].some(s => status.toLowerCase().includes(s))) return;
    order.status = "paid";
    await sendTicketEmail(order, ref);
  } catch (e) { console.error("Webhook error:", e.message); }
});

// ── 3. Statut commande (page succès) ─────────────────────────────────────────
app.get("/api/order-status", (req, res) => {
  const order = orders[req.query.ref];
  if (!order) return res.status(404).json({ error: "Commande introuvable." });
  res.json({ status: order.status, firstName: order.firstName, quantity: order.quantity });
});

// ── Email ticket ──────────────────────────────────────────────────────────────
async function sendTicketEmail(order, ref) {
  if (!resend) return console.warn("RESEND_API_KEY manquante, email non envoyé.");
  try {
    await resend.emails.send({
      from:    SENDER_EMAIL,
      to:      order.email,
      subject: `Ton ticket - ${EVENT_NAME}`,
      html:    buildTicketHtml(order, ref),
    });
    console.log("Email envoyé à", order.email);
  } catch (e) { console.error("Erreur email:", e.message); }
}

function buildTicketHtml(order, ref) {
  return `
  <div style="font-family:Georgia,serif;background:#0B1E3D;padding:32px 0;">
    <table align="center" width="420" style="background:#FFFDF7;border-radius:14px;border:1px solid #D4AF37;">
      <tr><td style="background:#0B1E3D;padding:24px 28px;">
        <p style="margin:0;color:#D4AF37;font-size:11px;letter-spacing:2px;text-transform:uppercase;">Billet d'entrée · PHRONESIS</p>
        <h1 style="margin:6px 0 0;color:#FFFDF7;font-size:20px;">${EVENT_NAME}</h1>
      </td></tr>
      <tr><td style="padding:24px 28px;">
        <p style="margin:0 0 4px;color:#777;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Titulaire</p>
        <p style="margin:0 0 16px;color:#0B1E3D;font-size:18px;font-weight:bold;">${order.firstName} ${order.lastName}</p>
        <p style="margin:0 0 4px;color:#777;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Tickets</p>
        <p style="margin:0 0 16px;color:#0B1E3D;font-size:18px;font-weight:bold;">${order.quantity}</p>
        <p style="margin:0 0 4px;color:#777;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Référence</p>
        <p style="margin:0 0 16px;color:#0B1E3D;font-size:15px;font-family:monospace;">${ref}</p>
        <div style="border-top:1px dashed #D4AF37;margin:16px 0;"></div>
        <p style="margin:0;color:#555;font-size:13px;line-height:1.5;">Présente ce billet à l'entrée. Merci et à bientôt !</p>
      </td></tr>
    </table>
  </div>`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
