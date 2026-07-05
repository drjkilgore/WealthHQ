// WealthHQ — AI Advisor (Netlify Function)
// Env var required in Netlify UI: ANTHROPIC_API_KEY

const SYSTEM = `You are the AI Advisor inside WealthHQ, a personal family office
operating system. You receive a JSON snapshot of the user's finances (assets,
liabilities, businesses, holdings, properties, goals, recent net-worth history)
plus a question. Answer like a sharp family-office CFO: concise, numeric,
specific, honest. Reference the actual figures in the snapshot. If data is
missing for a solid answer, say exactly what to add and where. Never invent
account values. Currency is USD. Keep answers under 250 words unless asked
for a full analysis. You provide financial information and analysis, not
licensed financial, legal, or tax advice — note this only when the question
turns on a decision that genuinely warrants a professional (e.g., large tax
moves, estate changes), and do it in one short sentence.`;

exports.handler = async function (event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST")
    return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };

  if (!process.env.ANTHROPIC_API_KEY)
    return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not set in Netlify environment variables." }) };

  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const question = String(payload.question || "").slice(0, 2000);
  const snapshot = payload.snapshot || {};
  const history = Array.isArray(payload.history) ? payload.history.slice(-8) : [];
  if (!question)
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing question" }) };

  const messages = [
    ...history.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content).slice(0, 4000) })),
    {
      role: "user",
      content:
        "FINANCIAL SNAPSHOT (JSON):\n" +
        JSON.stringify(snapshot).slice(0, 60000) +
        "\n\nQUESTION: " + question,
    },
  ];

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1200,
        system: SYSTEM,
        messages,
      }),
    });

    const data = await resp.json();
    if (!resp.ok)
      return { statusCode: resp.status, headers, body: JSON.stringify({ error: (data.error && data.error.message) || "Anthropic API error" }) };

    const text = (data.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n");

    return { statusCode: 200, headers, body: JSON.stringify({ answer: text }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err && err.message || err) }) };
  }
};
