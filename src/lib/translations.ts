export type Lang = "en" | "ta";

const translations: Record<string, Record<Lang, string>> = {
  // Page
  "page.title": { en: "Consumption Log", ta: "நுகர்வு பதிவு" },
  "page.subtitle": { en: "Log daily material usage", ta: "தினசரி பொருள் பயன்பாட்டை பதிவு செய்யவும்" },

  // Filters
  "filter.location": { en: "Location", ta: "இடம்" },
  "filter.department": { en: "Department", ta: "துறை" },
  "filter.search": { en: "Search items...", ta: "பொருட்களை தேடு..." },
  "filter.all": { en: "All", ta: "அனைத்தும்" },

  // Table headers
  "table.item_name": { en: "Item Name", ta: "பொருளின் பெயர்" },
  "table.available": { en: "Available", ta: "கையிருப்பு" },
  "table.unit": { en: "Unit", ta: "அலகு" },
  "table.consume_qty": { en: "Qty Used", ta: "பயன்படுத்திய அளவு" },
  "table.notes": { en: "Notes", ta: "குறிப்புகள்" },
  "table.reorder": { en: "Reorder Level", ta: "மறு ஆர்டர் நிலை" },

  // Actions
  "action.log": { en: "Log Consumption", ta: "நுகர்வை பதிவு செய்" },
  "action.confirm": { en: "Confirm & Submit", ta: "உறுதிசெய்து சமர்ப்பி" },
  "action.cancel": { en: "Cancel", ta: "ரத்து செய்" },
  "action.clear": { en: "Clear All", ta: "அனைத்தையும் நீக்கு" },

  // Confirmation dialog
  "confirm.title": { en: "Confirm Consumption", ta: "நுகர்வை உறுதிசெய்" },
  "confirm.message": { en: "You are about to log the following consumption:", ta: "பின்வரும் நுகர்வை பதிவு செய்ய உள்ளீர்கள்:" },
  "confirm.item": { en: "Item", ta: "பொருள்" },
  "confirm.quantity": { en: "Quantity", ta: "அளவு" },

  // Status messages
  "status.success": { en: "Consumption logged successfully", ta: "நுகர்வு வெற்றிகரமாக பதிவு செய்யப்பட்டது" },
  "status.error": { en: "Failed to log consumption", ta: "நுகர்வை பதிவு செய்ய இயலவில்லை" },
  "status.reorder_alert": { en: "items are below reorder level", ta: "பொருட்கள் மறு ஆர்டர் நிலைக்கு கீழே உள்ளன" },
  "status.no_items": { en: "No items available at this location", ta: "இந்த இடத்தில் பொருட்கள் எதுவும் இல்லை" },
  "status.no_qty": { en: "Enter quantity for at least one item", ta: "குறைந்தது ஒரு பொருளுக்கு அளவை உள்ளிடவும்" },
  "status.exceeds": { en: "Quantity exceeds available stock", ta: "அளவு கையிருப்பை மீறுகிறது" },

  // Language toggle
  "lang.english": { en: "English", ta: "English" },
  "lang.tamil": { en: "தமிழ்", ta: "தமிழ்" },

  // General
  "general.notes": { en: "Notes (optional)", ta: "குறிப்புகள் (விருப்பம்)" },
  "general.date": { en: "Date", ta: "தேதி" },
  "general.logged_by": { en: "Logged by", ta: "பதிவு செய்தவர்" },
};

export function t(key: string, lang: Lang): string {
  return translations[key]?.[lang] ?? translations[key]?.en ?? key;
}
