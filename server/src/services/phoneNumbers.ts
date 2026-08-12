import { parsePhoneNumberFromString } from "libphonenumber-js";

export class InvalidPhoneNumberError extends Error {}

export function normalizeNigerianPhone(value: string): string {
  const raw = value.trim();
  const parsed = parsePhoneNumberFromString(raw, "NG");
  if (!parsed || parsed.country !== "NG" || !parsed.isValid()) {
    throw new InvalidPhoneNumberError("Enter a valid Nigerian mobile number.");
  }

  const type = parsed.getType();
  if (type && type !== "MOBILE" && type !== "FIXED_LINE_OR_MOBILE") {
    throw new InvalidPhoneNumberError("Only Nigerian mobile numbers are supported.");
  }

  return parsed.number;
}

export function termiiDestination(phoneE164: string): string {
  return phoneE164.replace(/^\+/, "");
}

export function maskPhone(phoneE164: string): string {
  if (phoneE164.length < 8) return "***";
  return `${phoneE164.slice(0, 4)} *** *** ${phoneE164.slice(-3)}`;
}
