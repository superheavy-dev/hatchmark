import { z } from "zod";
import { schemaRef } from "./common.js";
import { filterSchema } from "./metric.js";

export const segmentSchema = z
  .strictObject({
    $schema: schemaRef.optional(),
    label: z.string().min(1).meta({ description: "Human name, such as External customers." }),
    description: z.string().optional(),
    filters: z.array(filterSchema).min(1).meta({
      description: "Row filters, all of which must hold. Applied to every source with the columns.",
    }),
  })
  .meta({ title: "Hatchmark segment (segments/<name>.json)" });
export type Segment = z.infer<typeof segmentSchema>;
