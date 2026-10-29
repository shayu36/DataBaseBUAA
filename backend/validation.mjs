import { z } from "zod";

// Query parameters and form fields may be numeric strings; other JSON types
// must not be converted into numbers by JavaScript's Number().
export const numericInput = z
  .union([z.number(), z.string().trim().min(1)])
  .pipe(z.coerce.number());

export const idSchema = numericInput.pipe(z.number().int().positive().safe());
