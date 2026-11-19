/**
 * SDK 0.48: free customer messaging by click-to-chat. Nothing is sent by a server: these build the text
 * and the wa.me / sms: links that open WhatsApp or the Messages app on the staff member's (or
 * shopper's) own device, with the message filled in for them to send. One copy of the wording, used by
 * Admin Mobile, POS and the Storefront.
 */

export type MessageLanguage = "en" | "ar";

export interface OrderMessageInput {
  /** Store name as the customer knows it, e.g. "Zee Store". */
  storeName: string;
  orderReference: string;
  /** Customer's name; only the first word is used. */
  customerName?: string | null;
  /** Already formatted, e.g. "EGP 1,250". */
  totalLabel?: string | null;
  /** e.g. "Nasr City". */
  deliveryCity?: string | null;
  /** Page where the customer can track this order, e.g. "https://zee.store/track". */
  trackingUrl?: string | null;
  language?: MessageLanguage;
}

function firstName(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/\s+/u)[0];
  return first && first.length > 0 ? first : null;
}

/** Staff -> customer: "we've got your order", sent right after an online order comes in. */
export function orderConfirmationMessage(input: OrderMessageInput): string {
  const name = firstName(input.customerName);
  const ref = `#${input.orderReference.replace(/^#/u, "")}`;
  if (input.language === "ar") {
    return [
      name ? `أهلاً ${name}،` : "أهلاً،",
      `شكراً لطلبك من ${input.storeName}. استلمنا طلبك رقم ${ref}${input.totalLabel ? ` بإجمالي ${input.totalLabel} (الدفع عند الاستلام)` : ""}.`,
      input.deliveryCity ? `هنوصله على ${input.deliveryCity}.` : null,
      "ممكن ترد بـ «تأكيد» عشان نبدأ نجهزه؟",
      input.trackingUrl ? `تقدر تتابع طلبك من هنا: ${input.trackingUrl}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    name ? `Hi ${name},` : "Hi,",
    `Thanks for shopping with ${input.storeName}! We've received your order ${ref}${input.totalLabel ? ` for ${input.totalLabel} (cash on delivery)` : ""}.`,
    input.deliveryCity ? `We'll deliver it to ${input.deliveryCity}.` : null,
    'Please reply "Confirm" so we can start preparing it.',
    input.trackingUrl ? `Track your order any time: ${input.trackingUrl}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Shopper -> store: sent from the order confirmation page to confirm a cash-on-delivery order. */
export function customerOrderConfirmMessage(input: {
  storeName: string;
  orderReference: string;
  language?: MessageLanguage;
}): string {
  const ref = `#${input.orderReference.replace(/^#/u, "")}`;
  return input.language === "ar"
    ? `أهلاً ${input.storeName}، بأكد طلبي رقم ${ref}.`
    : `Hi ${input.storeName}, I'm confirming my order ${ref}.`;
}

/** Digits only, with the country code, as wa.me expects ("+20 100-123" -> "20100123"). */
export function whatsAppNumber(phone: string): string | null {
  const digits = phone.replace(/[^0-9]/gu, "").replace(/^00/u, "");
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

/** https://wa.me/<number>?text=... ; null when the phone isn't usable. */
export function whatsAppLink(phone: string, text: string): string | null {
  const number = whatsAppNumber(phone);
  return number ? `https://wa.me/${number}?text=${encodeURIComponent(text)}` : null;
}

/**
 * sms:<number>?body=... ; null when the phone isn't usable. The "?body=" form works on Android and on
 * iOS 8+; the international "+" is kept.
 */
export function smsLink(phone: string, text: string): string | null {
  const cleaned = phone.trim().replace(/[^+0-9]/gu, "");
  if (whatsAppNumber(cleaned) === null) return null;
  return `sms:${cleaned}?body=${encodeURIComponent(text)}`;
}
