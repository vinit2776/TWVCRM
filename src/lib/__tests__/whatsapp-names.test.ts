import { describe, it, expect } from "vitest";
import { extractNameFromMessage, isPlaceholderName, pickProfileName, PLACEHOLDER_NAME } from "../whatsapp-names";

describe("extractNameFromMessage", () => {
  it("finds a name after a self-introduction", () => {
    expect(extractNameFromMessage("Hi, I'm Rahul from Acme Traders. Need a cabin")).toBe("Rahul");
    expect(extractNameFromMessage("this is meera sharma, looking for 4 seats")).toBe("Meera Sharma");
    expect(extractNameFromMessage("My name is anil kumar")).toBe("Anil Kumar");
    expect(extractNameFromMessage("Hello myself Priya")).toBe("Priya");
  });
  it("does not mistake ordinary phrases for a name", () => {
    expect(extractNameFromMessage("I am looking for a cabin")).toBeNull();
    expect(extractNameFromMessage("I'm interested in a private office")).toBeNull();
    expect(extractNameFromMessage("this is urgent, call me")).toBeNull();
    expect(extractNameFromMessage("this is the price list?")).toBeNull();
    expect(extractNameFromMessage("Do you have meeting rooms")).toBeNull();
  });
});

describe("pickProfileName", () => {
  it("reads a plain key, a contacts array, and a contacts array inside content", () => {
    expect(pickProfileName({ profileName: " Rahul S " })).toBe("Rahul S");
    expect(pickProfileName({ contacts: [{ profile: { name: "Meera K" }, wa_id: "91" }] })).toBe("Meera K");
    expect(pickProfileName({ content: JSON.stringify({ contacts: [{ profile: { name: "Dev P" } }] }) })).toBe("Dev P");
    expect(pickProfileName({ contacts: JSON.stringify([{ profile: { name: "Asha" } }]) })).toBe("Asha");
  });
  it("returns null for nothing usable", () => {
    expect(pickProfileName({ customerName: "[object Object]" })).toBeNull();
    expect(pickProfileName({ content: "null" })).toBeNull();
    expect(pickProfileName({})).toBeNull();
  });
});

describe("isPlaceholderName", () => {
  it("only the placeholder counts", () => {
    expect(isPlaceholderName(PLACEHOLDER_NAME)).toBe(true);
    expect(isPlaceholderName("Rahul")).toBe(false);
    expect(isPlaceholderName(null)).toBe(false);
  });
});
