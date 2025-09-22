// api/chat.js

import formidable from "formidable";
import { readFile } from "fs/promises";
import OpenAI from "openai";

export const config = {
  api: {
    bodyParser: false,
  },
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const assistantId = process.env.ASSISTANT_ID;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const form = formidable({ multiples: false });
  const fields = await new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });

  const { message, thread_id } = fields.fields;
  const screenshot = fields.files?.screenshot;

  try {
    let thread = thread_id || (await openai.beta.threads.create()).id;

    let fileId = null;
    if (screenshot) {
      const fileData = await readFile(screenshot.filepath);
      const uploaded = await openai.files.create({
        file: fileData,
        purpose: "assistants",
        filename: screenshot.originalFilename,
      });
      fileId = uploaded.id;
    }

    await openai.beta.threads.messages.create(thread, {
      role: "user",
      content: message,
      file_ids: fileId ? [fileId] : [],
    });

    const run = await openai.beta.threads.runs.create(thread, {
      assistant_id: assistantId,
    });

    let status;
    let runResult;
    do {
      await new Promise((r) => setTimeout(r, 1500));
      runResult = await openai.beta.threads.runs.retrieve(thread, run.id);
      status = runResult.status;
    } while (status !== "completed" && status !== "failed");

    if (fileId) await openai.files.del(fileId);

    const messages = await openai.beta.threads.messages.list(thread);
    const reply = messages.data.find((m) => m.role === "assistant")?.content[0]?.text?.value || "No reply.";

    res.status(200).json({ reply, thread_id: thread });
  } catch (err) {
    console.error("API error:", err);
    res.status(500).json({ error: "Something went wrong." });
  }
}
