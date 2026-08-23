"use client";

/**
 * A phone field with its country in front of it.
 *
 * One control, one stored string. The select and the text box are two views of
 * `value`, never separate state, so there is nothing to keep in step and no way
 * for the code shown to disagree with the code saved.
 *
 * A number stored before this existed keeps no country (see `splitPhone`), and
 * the select shows "No country code" for it rather than quietly asserting +1.
 */

import * as React from "react";
import { Input, Select } from "@/components/ui/primitives";
import { DEFAULT_DIAL_CODE, DIAL_CODES, formatNationalNumber, joinPhone, splitPhone } from "@/lib/phone";

export function PhoneInput({
  value, onChange, placeholder, id,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  id?: string;
}) {
  const { dialCode, rest } = splitPhone(value);

  // An empty field starts at the default rather than at "no country", because
  // an empty field is somebody about to type, not a legacy record.
  const selected = value.trim() === "" ? DEFAULT_DIAL_CODE : dialCode;

  return (
    <div className="flex items-center gap-2">
      <Select
        aria-label="Country code"
        className="w-[132px] shrink-0"
        value={selected ?? ""}
        onChange={(e) => onChange(joinPhone(e.target.value || null, rest))}
      >
        {selected === null && <option value="">No country code</option>}
        {DIAL_CODES.map((d) => (
          <option key={d.code} value={d.code}>{d.label}</option>
        ))}
      </Select>
      <Input
        id={id}
        type="tel"
        inputMode="tel"
        value={rest}
        placeholder={placeholder ?? (selected === "+1" ? "(312) 555-0100" : "Phone number")}
        onChange={(e) => onChange(joinPhone(selected, e.target.value))}
        /*
          Shaped on blur rather than on every keystroke. Formatting while
          somebody types means the caret jumps whenever a bracket or a dash is
          inserted ahead of it, and editing the middle of a number becomes a
          fight. Nothing is lost by waiting: the stored value is the same either
          way.
        */
        onBlur={(e) => onChange(joinPhone(selected, formatNationalNumber(e.target.value, selected)))}
      />
    </div>
  );
}
