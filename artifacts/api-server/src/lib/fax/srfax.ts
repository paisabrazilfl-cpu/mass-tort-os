import type { FaxAdapter, FaxSendOutcome } from "./types";
import { logger } from "../logger";

/**
 * SRFax adapter.
 * API: https://www.srfax.com/api
 * Auth: account number (access_id) + password (access_pwd) sent in JSON body.
 *
 * Credential fields (from integration-presets):
 *   access_id        — SRFax account number (e.g. "432213")
 *   access_password  — API password (login password by default)
 *   fax_number       — Caller ID fax number in E.164 (e.g. "+16144552138")
 *
 * SRFax wants 10-digit US numbers (no leading +1) for sCallerID and sToFaxNumber.
 */

const SRFAX_URL = "https://www.srfax.com/SRF_SecWebSvc.php";

function toTenDigit(num: string): string {
  const digits = num.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

export const srfaxAdapter: FaxAdapter = {
  provider: "srfax",

  async send(creds, req): Promise<FaxSendOutcome> {
    const accessId = creds.access_id;
    const accessPwd = creds.access_password;
    const callerId = creds.fax_number;

    if (!accessId || !accessPwd) {
      return { ok: false, retryable: false, code: "no_credentials", message: "SRFax access_id or access_password missing" };
    }
    if (!req.toNumber) {
      return { ok: false, retryable: false, code: "no_to_number", message: "Recipient fax number missing" };
    }
    const fromTen = callerId ? toTenDigit(callerId) : "";
    if (!fromTen) {
      return {
        ok: false,
        retryable: false,
        code: "no_from_number",
        message: "SRFax caller ID missing — set fax_number on the SRFax integration",
      };
    }

    const payload = {
      action: "Queue_Fax",
      access_id: accessId,
      access_pwd: accessPwd,
      sCallerID: fromTen,
      sSenderEmail: creds.sender_email || "",
      sFaxType: "SINGLE",
      sToFaxNumber: toTenDigit(req.toNumber),
      sFileName_1: req.fileName,
      sFileContent_1: req.pdf.toString("base64"),
    };

    let response: Response;
    try {
      response = await fetch(SRFAX_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      logger.error({ err, provider: "srfax" }, "Network error sending fax");
      return { ok: false, retryable: true, code: "network_error", message: String((err as Error).message) };
    }

    let body: any = null;
    try {
      body = await response.json();
    } catch {
      // ignore
    }

    if (!response.ok) {
      return {
        ok: false,
        retryable: response.status >= 500 || response.status === 429,
        code: `http_${response.status}`,
        message: `HTTP ${response.status}`,
        rawResponse: body,
      };
    }

    if (body?.Status !== "Success") {
      return {
        ok: false,
        retryable: false,
        code: "srfax_error",
        message: String(body?.Result || "SRFax queue failed"),
        rawResponse: body,
      };
    }

    const faxId = String(body?.Result || "");
    if (!faxId) {
      return {
        ok: false,
        retryable: false,
        code: "no_fax_id",
        message: "SRFax returned Success but no fax id",
        rawResponse: body,
      };
    }

    return { ok: true, externalFaxId: faxId, rawResponse: body };
  },

  async getStatus(creds, externalFaxId): Promise<string> {
    const accessId = creds.access_id;
    const accessPwd = creds.access_password;
    if (!accessId || !accessPwd) return "unknown";

    try {
      const res = await fetch(SRFAX_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "Get_FaxStatus",
          access_id: accessId,
          access_pwd: accessPwd,
          sFaxDetailsID: externalFaxId,
        }),
      });
      if (!res.ok) return "unknown";
      const body = (await res.json()) as { Status?: string; Result?: Array<{ SentStatus?: string }> | string };
      if (body?.Status !== "Success") return "unknown";
      const result = Array.isArray(body.Result) ? body.Result[0] : null;
      return result?.SentStatus || "unknown";
    } catch {
      return "unknown";
    }
  },
};
