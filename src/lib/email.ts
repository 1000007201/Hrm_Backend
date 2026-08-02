import { Resend } from "resend";
import { env } from "../env.js";

interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
}

// No API key in dev → log instead of sending, so local dev doesn't need a real provider.
const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

export const sendEmail = async ({ to, subject, html }: SendEmailInput): Promise<void> => {
  if (!resend) {
    console.log(`[email] to=${to} subject=${JSON.stringify(subject)}\n${html}`);
    return;
  }

  const { error } = await resend.emails.send({ from: env.EMAIL_FROM, to, subject, html });
  if (error) {
    console.error("sendEmail failed:", error);
  }
};
