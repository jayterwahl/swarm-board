// Outbound email. Uses Resend when RESEND_API_KEY + REPORT_EMAIL are set; otherwise a no-op
// that reports why, so the daily report still lands in the /mod page.
export async function sendEmail({ subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.REPORT_EMAIL;
  if (!key || !to) return { sent: false, reason: !key ? 'RESEND_API_KEY not set' : 'REPORT_EMAIL not set' };
  const from = process.env.REPORT_FROM || 'swarm-board <reports@swarm-board.com>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html, text }),
  });
  if (!res.ok) return { sent: false, reason: `Resend ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const data = await res.json();
  return { sent: true, id: data.id };
}
