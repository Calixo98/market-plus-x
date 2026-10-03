// Chat-only policy. Set to true and redeploy to restore Turnstile for new chat sessions.
// Checkout verification and message/session rate limits are independent and remain enabled.
module.exports = { turnstileRequired: false };
