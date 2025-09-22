import formidable from "formidable";
import { createReadStream } from "fs";
import OpenAI from "openai";

// For Next.js API routes; harmless on Vercel serverless too
export const config = { api: { bodyParser: false } };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const assistantId = process.env.ASSISTANT_ID;

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    // Parse multipart/form-data (message, thread_id, screenshot)
    const form = formidable({
      multiples: false,
      maxFiles: 1,
      maxFileSize: 10 * 1024 * 1024, // 10MB
      filter: ({ mimetype }) =>
        !mimetype ||
        ["image/png", "image/jpeg", "image/jpg"].includes(mimetype.toLowerCase())
    });

    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => (err ? reject(err) : resolve({ fields, files })));
    });

    const message = (fields.message ?? "").toString().slice(0, 4000);
    const incomingThreadId = fields.thread_id ? fields.thread_id.toString() : null;
    const screenshotFile = files?.screenshot;

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }
    if (!assistantId) {
      return res.status(500).json({ error: "Missing ASSISTANT_ID" });
    }

    // Create or reuse thread
    let threadId = incomingThreadId;
    if (!threadId) {
      const t = await openai.beta.threads.create();
      threadId = t.id;
    }

    // Optional: upload screenshot
    let fileId = null;
    if (screenshotFile && screenshotFile.filepath) {
      const uploaded = await openai.files.create({
        file: createReadStream(screenshotFile.filepath),
        purpose: "assistants",
        filename: screenshotFile.originalFilename || "screenshot.jpg"
      });
      fileId = uploaded.id;
    }

    // Add user message
    await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: message || "(User uploaded a screenshot.)",
      file_ids: fileId ? [fileId] : []
    });

    // Run the assistant
    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: assistantId
    });

    // Poll until the run completes (or fails)
    let runStatus = "queued";
    let attempts = 0;
    while (
      !["completed", "failed", "cancelled", "expired"].includes(runStatus) &&
      attempts < 120 // ~2 min max
    ) {
      await new Promise((r) => setTimeout(r, 1200));
      const current = await openai.beta.threads.runs.retrieve(threadId, run.id);
      runStatus = current.status;
      attempts++;
    }

    // Delete uploaded file for privacy
    if (fileId) {
      try {
        await openai.files.del(fileId);
      } catch {
        // swallow deletion errors to not break the response
      }
    }

    if (runStatus !== "completed") {
      return res.status(500).json({ error: `Run status: ${runStatus}`, thread_id: threadId });
    }

    // Get the latest assistant reply
    const list = await openai.beta.threads.messages.list(threadId, { order: "desc", limit: 10 });
    const assistantMsg = list.data.find((m) => m.role === "assistant");

    let reply = "No reply.";
    if (assistantMsg?.content?.length) {
      const textPart = assistantMsg.content.find((p) => p.type === "text");
      if (textPart?.text?.value) reply = textPart.text.value;
    }

    return res.status(200).json({ reply, thread_id: threadId });
  } catch (err) {
    console.error("chat API error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
