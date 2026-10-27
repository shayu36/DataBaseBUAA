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
  tickets: Row[];
  attempts: Row[];
  attempts_next_before: number | null;
  carbon: {
    points: number;
    carbon_kg: number;
    distance_m: number;
    ride_count: number;
    entries: Row[];
    entries_next_before: number | null;
  };
  summary: Record<string, number>;
};
