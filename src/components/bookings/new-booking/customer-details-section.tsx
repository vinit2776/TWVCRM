"use client";

import { memo } from "react";
import { Search, Phone, User2, Building2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { BOOKING_CUSTOMER_TYPE_LABELS } from "@/lib/constants";
import { useBookingForm } from "./booking-form-context";

export const CustomerDetailsSection = memo(function CustomerDetailsSection() {
  const {
    bookerPhone, setBookerPhone, customerSearchQuery, customerSuggestions,
    searchLoading, showSuggestions, setShowSuggestions, suggestionsRef,
    customerType, setCustomerType, contractId, setContractId, leadId, setLeadId,
    guestName, setGuestName, guestEmail, setGuestEmail, guestPhone, setGuestPhone,
    guestCompany, setGuestCompany, bookerGstNumber, setBookerGstNumber,
    gstError, setGstError, selectedCustomer,
    idProofFile, setIdProofFile, leadHasIdProof, idProofLookingUp,
    contracts, handleSearchInput, selectCustomerSuggestion, clearCustomerSelection,
  } = useBookingForm();

  const contractOptions = contracts.map(c => ({
    value: c.id,
    label: `${c.contract_number} — ${c.lead?.company || `${c.lead?.first_name} ${c.lead?.last_name}`}`,
  }));

  const handleContractSelect = (value: string) => {
    setContractId(value);
    const contract = contracts.find(c => c.id === value);
    const phone = contract?.lead?.mobile || contract?.lead?.phone;
    if (phone) setBookerPhone(phone);
  };

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">2. Customer Details</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {/* Customer type selector */}
        <div className="flex gap-2">
          {(["contract_holder", "walk_in"] as const).map(type => (
            <Button
              key={type}
              type="button"
              variant={customerType === type ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setCustomerType(type);
                if (!selectedCustomer) {
                  setContractId(""); setLeadId(""); setGuestName(""); setGuestEmail(""); setGuestPhone(""); setGuestCompany("");
                }
              }}
            >
              {BOOKING_CUSTOMER_TYPE_LABELS[type]}
            </Button>
          ))}
        </div>

        {/* Phone search bar */}
        <div className="space-y-2">
          <Label className="flex items-center gap-1.5">
            <Phone className="h-3.5 w-3.5" />
            Search by Mobile Number or Name *
          </Label>
          <div className="relative" ref={suggestionsRef}>
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={customerSearchQuery}
              onChange={(e) => handleSearchInput(e.target.value)}
              onFocus={() => customerSuggestions.length > 0 && setShowSuggestions(true)}
              placeholder="Enter mobile number, name, or company..."
              className="pl-9"
            />
            {searchLoading && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />}

            {/* Dropdown suggestions */}
            {showSuggestions && customerSuggestions.length > 0 && (
              <div className="absolute z-50 top-full left-0 right-0 mt-1 border rounded-md bg-white shadow-lg max-h-64 overflow-y-auto">
                {customerSuggestions.map((sug, i) => (
                  <button
                    key={i}
                    type="button"
                    className="w-full px-3 py-2.5 text-left hover:bg-muted/50 border-b last:border-b-0 transition-colors"
                    onClick={() => selectCustomerSuggestion(sug)}
                  >
                    <div className="flex items-center gap-2">
                      {sug.type === "contract" ? (
                        <Badge variant="outline" className="text-[10px] bg-emerald-50 text-emerald-700 shrink-0">Contract</Badge>
                      ) : sug.type === "lead" ? (
                        <Badge variant="outline" className="text-[10px] bg-blue-50 text-blue-700 shrink-0">Lead</Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] bg-purple-50 text-purple-700 shrink-0">Past Guest</Badge>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <User2 className="h-3 w-3 text-muted-foreground shrink-0" />
                          <span className="truncate">{sug.name}</span>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                          {sug.phone && <span className="flex items-center gap-1"><Phone className="h-2.5 w-2.5" />{sug.phone}</span>}
                          {sug.company && <span className="flex items-center gap-1"><Building2 className="h-2.5 w-2.5" />{sug.company}</span>}
                          {sug.contract_number && <span className="font-mono">{sug.contract_number}</span>}
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <p className="text-xs text-muted-foreground">Type at least 3 characters. Searches across contracts, leads, and past bookings.</p>
        </div>

        {/* Selected customer info */}
        {selectedCustomer && (
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className={`text-[10px] ${
                  selectedCustomer.type === "contract" ? "bg-emerald-50 text-emerald-700" :
                  selectedCustomer.type === "lead" ? "bg-blue-50 text-blue-700" :
                  "bg-purple-50 text-purple-700"
                }`}>
                  {selectedCustomer.type === "contract" ? "Contract Holder" : selectedCustomer.type === "lead" ? "Lead" : "Past Guest"}
                </Badge>
                <span className="text-sm font-medium">{selectedCustomer.name}</span>
              </div>
              <Button variant="ghost" size="sm" className="text-xs h-7" onClick={clearCustomerSelection}>Clear</Button>
            </div>
            <div className="flex gap-4 text-xs text-muted-foreground">
              {selectedCustomer.phone && <span>📱 {selectedCustomer.phone}</span>}
              {selectedCustomer.email && <span>✉ {selectedCustomer.email}</span>}
              {selectedCustomer.company && <span>🏢 {selectedCustomer.company}</span>}
              {selectedCustomer.contract_number && <span>📋 {selectedCustomer.contract_number}</span>}
            </div>
          </div>
        )}

        {/* Contract Holder */}
        {customerType === "contract_holder" && (
          <div className="space-y-2">
            <Label>Active Contract *</Label>
            <SearchableSelect
              options={contractOptions}
              value={contractId}
              onValueChange={handleContractSelect}
              placeholder="Select contract"
              searchPlaceholder="Search by contract # or name..."
              emptyMessage="No matching contracts."
            />
            <p className="text-xs text-muted-foreground">Booking amount will be posted to their billing. Mobile number auto-fills from the contract.</p>
          </div>
        )}

        {/* Walk-in (no selected customer) */}
        {customerType === "walk_in" && !selectedCustomer && (
          <WalkInFields
            guestName={guestName} setGuestName={setGuestName}
            guestEmail={guestEmail} setGuestEmail={setGuestEmail}
            guestPhone={guestPhone} setGuestPhone={setGuestPhone}
            guestCompany={guestCompany} setGuestCompany={setGuestCompany}
            bookerGstNumber={bookerGstNumber} setBookerGstNumber={setBookerGstNumber}
            gstError={gstError} setGstError={setGstError}
            idProofFile={idProofFile} setIdProofFile={setIdProofFile}
            leadHasIdProof={leadHasIdProof} idProofLookingUp={idProofLookingUp}
          />
        )}

        {/* Walk-in with selected customer */}
        {customerType === "walk_in" && selectedCustomer && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Customer details loaded from {selectedCustomer.type === "lead" ? "lead" : "past booking"} record.</p>
            <IdProofSection
              idProofLookingUp={idProofLookingUp} leadHasIdProof={leadHasIdProof}
              idProofFile={idProofFile} setIdProofFile={setIdProofFile}
            />
          </div>
        )}

        {/* Booker phone */}
        <div className="space-y-2">
          <Label>Booker Mobile Number *</Label>
          <Input
            value={bookerPhone}
            onChange={(e) => setBookerPhone(e.target.value)}
            placeholder="+91 98765 43210"
            required
          />
          <p className="text-xs text-muted-foreground">Mandatory. This is the primary contact for the booking.</p>
        </div>
      </CardContent>
    </Card>
  );
});

// Shared walk-in / guest fields
function WalkInFields({
  guestName, setGuestName, guestEmail, setGuestEmail,
  guestPhone, setGuestPhone, guestCompany, setGuestCompany,
  bookerGstNumber, setBookerGstNumber, gstError, setGstError,
  idProofFile, setIdProofFile, leadHasIdProof, idProofLookingUp,
}: {
  guestName: string; setGuestName: (v: string) => void;
  guestEmail: string; setGuestEmail: (v: string) => void;
  guestPhone: string; setGuestPhone: (v: string) => void;
  guestCompany: string; setGuestCompany: (v: string) => void;
  bookerGstNumber: string; setBookerGstNumber: (v: string) => void;
  gstError: string | null; setGstError: (v: string | null) => void;
  idProofFile: File | null; setIdProofFile: (v: File | null) => void;
  leadHasIdProof: boolean; idProofLookingUp: boolean;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div className="space-y-2">
        <Label>Guest Name *</Label>
        <Input value={guestName} onChange={(e) => setGuestName(e.target.value)} placeholder="Full name" />
      </div>
      <div className="space-y-2">
        <Label>Guest Email</Label>
        <Input type="email" value={guestEmail} onChange={(e) => setGuestEmail(e.target.value)} placeholder="email@example.com" />
      </div>
      <div className="space-y-2">
        <Label>Guest Phone</Label>
        <Input value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} placeholder="Phone number" />
      </div>
      <div className="space-y-2">
        <Label>Guest Company</Label>
        <Input value={guestCompany} onChange={(e) => setGuestCompany(e.target.value)} placeholder="Company name" />
      </div>
      <div className="space-y-2 sm:col-span-2">
        <Label>GST Number <span className="text-muted-foreground font-normal text-xs">(Optional — for tax invoice)</span></Label>
        <Input
          value={bookerGstNumber}
          onChange={(e) => {
            const val = e.target.value.toUpperCase();
            setBookerGstNumber(val);
            if (val && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(val)) {
              setGstError("Format: 33AAAAA0000A1Z5 (15 characters)");
            } else {
              setGstError(null);
            }
          }}
          placeholder="e.g. 33AAAAA0000A1Z5"
          maxLength={15}
          className={gstError ? "border-red-400" : ""}
        />
        {gstError && <p className="text-xs text-red-500">{gstError}</p>}
        {!gstError && bookerGstNumber.length === 15 && <p className="text-xs text-green-600">✓ Valid GST format</p>}
      </div>
      <div className="sm:col-span-2">
        <IdProofSection
          idProofLookingUp={idProofLookingUp} leadHasIdProof={leadHasIdProof}
          idProofFile={idProofFile} setIdProofFile={setIdProofFile}
        />
      </div>
    </div>
  );
}

function IdProofSection({
  idProofLookingUp, leadHasIdProof, idProofFile, setIdProofFile,
}: {
  idProofLookingUp: boolean; leadHasIdProof: boolean;
  idProofFile: File | null; setIdProofFile: (v: File | null) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label>Government ID Proof <span className="text-red-500">*</span> <span className="text-muted-foreground font-normal text-xs">(Aadhaar, PAN, Passport, DL)</span></Label>
      {idProofLookingUp ? (
        <p className="text-xs text-muted-foreground">Checking ID records…</p>
      ) : leadHasIdProof ? (
        <p className="text-xs text-green-600 font-medium">✓ ID on file — no re-upload needed</p>
      ) : (
        <>
          <Input
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            onChange={(e) => setIdProofFile(e.target.files?.[0] || null)}
            className="cursor-pointer"
          />
          <p className="text-xs text-muted-foreground">JPG, PNG, WebP, or PDF · Max 2 MB · Images auto-compressed</p>
          {idProofFile && <p className="text-xs text-green-600">✓ {idProofFile.name} selected</p>}
        </>
      )}
    </div>
  );
}
