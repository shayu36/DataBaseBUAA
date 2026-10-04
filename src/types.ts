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
  payments: Row[];
  staff: Row[];
  dispatches: Row[];
  tickets: Row[];
  attempts: Row[];
  carbon: {
    points: number;
    carbon_kg: number;
    distance_m: number;
    entries: Row[];
  };
  summary: Record<string, number>;
};
