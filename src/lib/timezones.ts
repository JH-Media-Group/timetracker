/**
 * IANA timezone choices and the metadata a person needs to choose one.
 *
 * Never store a UTC offset in place of a timezone. `UTC-05:00` describes one
 * instant; `America/Cancun` describes the regional rules for every instant,
 * including the fact that Cancun no longer changes its clocks. The rest of
 * the application already passes the stored IANA identifier to `Intl`, so the
 * platform timezone database remains the only daylight-saving authority.
 */

export type TimeZoneOption = {
  id: string;
  city: string;
  region: string;
  currentOffset: string;
  changesOffset: boolean;
  changeLabel: string;
  searchText: string;
};

type IntlWithTimeZones = typeof Intl & {
  supportedValuesOf?: (key: "timeZone") => string[];
};

const collator = new Intl.Collator("en", { sensitivity: "base" });

/** Whether the runtime's timezone database accepts this identifier. */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Every canonical IANA zone supported by this runtime.
 *
 * `Intl.supportedValuesOf("timeZone")` is backed by the same timezone database
 * that formats dates later, so the picker cannot offer a zone the application
 * cannot apply. The specification omits UTC from that list even though every
 * runtime accepts it, so it is added explicitly. A valid existing alias is
 * retained as well, which means opening an older imported record never changes
 * its value merely because IANA later made another identifier canonical.
 */
export function supportedTimeZoneIds(current?: string): string[] {
  const supported = (Intl as IntlWithTimeZones).supportedValuesOf?.("timeZone") ?? [];
  const ids = new Set<string>(["UTC", ...supported]);
  if (current && isTimeZone(current)) ids.add(current);

  return [...ids].sort((a, b) => {
    if (a === "UTC") return -1;
    if (b === "UTC") return 1;
    return collator.compare(a, b);
  });
}

const words = (value: string) => value.replaceAll("_", " ");

function offsetFormatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
    hour: "2-digit",
  });
}

function offsetFrom(formatter: Intl.DateTimeFormat, at: Date): string {
  const name = formatter.formatToParts(at).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const offset = name.replace(/^GMT/, "UTC");
  return offset === "UTC+00:00" || offset === "UTC-00:00" ? "UTC" : offset;
}

/** Metadata is deliberately computed for a named year so tests do not age. */
export function describeTimeZone(
  id: string,
  at: Date = new Date(),
  year: number = at.getUTCFullYear()
): TimeZoneOption {
  const parts = id.split("/");
  const city = id === "UTC" ? "UTC" : words(parts.at(-1) ?? id);
  const region = parts.length > 1 ? words(parts[0]) : "Universal";
  const formatter = offsetFormatter(id);
  const currentOffset = offsetFrom(formatter, at);

  // Sampling every month catches ordinary northern and southern hemisphere
  // DST, half-hour changes such as Lord Howe, and regional exceptions whose
  // transitions do not happen near the usual March and November dates.
  const annualOffsets = new Set(
    Array.from({ length: 12 }, (_, month) =>
      offsetFrom(formatter, new Date(Date.UTC(year, month, 15, 12)))
    )
  );
  const changesOffset = annualOffsets.size > 1;
  const changeLabel = changesOffset
    ? `Offset changes in ${year}`
    : `No offset change in ${year}`;
  const clockSearch = changesOffset
    ? "daylight saving dst seasonal clock changes"
    : "no daylight saving no dst fixed offset year round no clock change";

  return {
    id,
    city,
    region,
    currentOffset,
    changesOffset,
    changeLabel,
    searchText: `${id} ${city} ${region} ${currentOffset} ${changeLabel} ${clockSearch}`.toLowerCase(),
  };
}

export function timeZoneOptions(current?: string, at: Date = new Date()): TimeZoneOption[] {
  const year = at.getUTCFullYear();
  return supportedTimeZoneIds(current).map((id) => describeTimeZone(id, at, year));
}
