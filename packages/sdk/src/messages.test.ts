import { describe, expect, it } from "vitest";

import {
  customerOrderConfirmMessage,
  orderConfirmationMessage,
  orderShippedMessage,
  smsLink,
  whatsAppLink,
  whatsAppNumber,
} from "./messages";

describe("click-to-chat messages", () => {
  it("writes the English confirmation with only what is known", () => {
    expect(
      orderConfirmationMessage({
        storeName: "Zee Store",
        orderReference: "1042",
        customerName: "Omar Hassan",
        totalLabel: "EGP 1,250",
        deliveryCity: "Nasr City",
        trackingUrl: "https://zee.example/track",
      }),
    ).toBe(
      [
        "Hi Omar,",
        "Thanks for shopping with Zee Store! We've received your order #1042 for EGP 1,250 (cash on delivery).",
        "We'll deliver it to Nasr City.",
        'Please reply "Confirm" so we can start preparing it.',
        "Track your order any time: https://zee.example/track",
      ].join("\n"),
    );
    expect(orderConfirmationMessage({ storeName: "Zee Store", orderReference: "#7" })).toBe(
      [
        "Hi,",
        "Thanks for shopping with Zee Store! We've received your order #7.",
        'Please reply "Confirm" so we can start preparing it.',
      ].join("\n"),
    );
  });

  it("writes the Arabic confirmation", () => {
    const text = orderConfirmationMessage({
      storeName: "Zee Store",
      orderReference: "1042",
      customerName: "عمر",
      language: "ar",
    });
    expect(text.startsWith("أهلاً عمر،")).toBe(true);
    expect(text).toContain("#1042");
    expect(
      customerOrderConfirmMessage({ storeName: "Zee", orderReference: "9", language: "ar" }),
    ).toContain("#9");
  });

  it("builds wa.me and sms links, refusing unusable numbers", () => {
    expect(whatsAppNumber("+20 100-123-4567")).toBe("201001234567");
    expect(whatsAppNumber("0020 100 123 4567")).toBe("201001234567");
    expect(whatsAppNumber("123")).toBeNull();
    expect(whatsAppLink("+201001234567", "Hi & bye")).toBe(
      "https://wa.me/201001234567?text=Hi%20%26%20bye",
    );
    expect(smsLink("+20 100 123 4567", "Hi")).toBe("sms:+201001234567?body=Hi");
    expect(whatsAppLink("abc", "x")).toBeNull();
    expect(smsLink("12", "x")).toBeNull();
  });
});

describe("orderShippedMessage", () => {
  it("tells the customer the order is on its way, with the amount to have ready", () => {
    const text = orderShippedMessage({
      storeName: "Zee Store",
      orderReference: "21",
      customerName: "Omar Hassan",
      totalLabel: "EGP 510.68",
      deliveryCity: "Dokki",
      trackingUrl: "https://zee.example/track?order=21",
    });
    expect(text).toContain("Hi Omar,");
    expect(text).toContain("your Zee Store order #21 is on its way to Dokki.");
    expect(text).toContain("EGP 510.68 ready to pay on delivery");
    expect(text).not.toContain("Confirm");
    expect(
      orderShippedMessage({ storeName: "Zee", orderReference: "7", language: "ar" }),
    ).toContain("في الطريق");
  });
});
