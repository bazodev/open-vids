import { CLIP_FITS, EDIT_LIMITS, type EditOperationName } from "@hyperframes/agent-protocol";

export const str = (description: string, maxLength?: number) => ({
  type: "string",
  description,
  ...(maxLength !== undefined && { maxLength }),
});
export const time = (description: string) => ({
  type: "number",
  minimum: 0,
  maximum: EDIT_LIMITS.maxTime,
  description,
});
export const track = (description: string) => ({
  type: "integer",
  minimum: 0,
  maximum: EDIT_LIMITS.maxTrack,
  description,
});
export const clipId = str(
  "Clip id from inspect_timeline or an earlier edit result.",
  EDIT_LIMITS.idChars,
);
export const volume = {
  type: "number",
  minimum: 0,
  maximum: EDIT_LIMITS.maxVolume,
  description: "Volume: 1 = the source level; music under speech about 0.2–0.4.",
};
export const fade = (edge: string) => ({
  type: "number",
  minimum: 0,
  maximum: EDIT_LIMITS.maxTime,
  description: `Seconds of linear audio/video gain ramp at the clip's ${edge}; 1–2 s suits a music bed.`,
});
export const fit = {
  type: "string",
  enum: [...CLIP_FITS],
  description: "contain shows all of the frame; cover fills it.",
};
export const frame = {
  type: "object",
  description:
    "Position and size in composition pixels (left/top corner, width, height), e.g. a logo in a corner.",
  properties: {
    x: { type: "number" },
    y: { type: "number" },
    width: { type: "number", exclusiveMinimum: 0 },
    height: { type: "number", exclusiveMinimum: 0 },
  },
  required: ["x", "y", "width", "height"],
  additionalProperties: false,
};
export const canvasSide = {
  type: "integer",
  minimum: 2,
  maximum: EDIT_LIMITS.maxCanvasPixels,
  multipleOf: 2,
  description: `Even pixels, up to ${EDIT_LIMITS.maxCanvasPixels} (the render encodes H.264).`,
};

export interface OperationSchema {
  type: "object";
  description: string;
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

/**
 * One operation of `edit_timeline`. An optional list declares no `minItems`: a model that fills it with `[]` means "not
 * given" (`withoutBlankArguments`), and with a minimum the SDK would refuse the whole union before that reading, naming
 * the required fields of an unrelated operation.
 */
export function operationSchema(
  op: EditOperationName,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): OperationSchema {
  return {
    type: "object",
    description,
    properties: { op: { type: "string", enum: [op] }, ...properties },
    required: ["op", ...required],
    additionalProperties: false,
  };
}
