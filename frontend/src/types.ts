export type Row = { id: number; [key: string]: any };
export type User = Row & {
  name: string;
  email: string;
  role: "ADMIN" | "STUDENT" | "OPERATOR";
};
export type Dashboard = {
  zones: Row[];
  bikes: Row[];
  rides: Row[];
  rides_next_before: number | null;
  actionable_rides: Row[];
  payments: Row[];
  payments_next_before: number | null;
  staff: Row[];
  dispatches: Row[];
  dispatches_next_before: number | null;
  tickets: Row[];
  tickets_next_before: number | null;
  attempts: Row[];
  attempts_next_before: number | null;
  carbon: {
    points: number;
    carbon_kg: number;
    distance_m: number;
    ride_count: number;
    rule: { kg_per_km: number; points_per_km: number; rule_version: string };
    entries: Row[];
    entries_next_before: number | null;
  };
  summary: Record<string, number>;
};
