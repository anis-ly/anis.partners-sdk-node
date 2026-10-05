/** One public error representation from the published catalogue. */
interface ErrorRepresentation {
  /** Stable public wire code. */
  publicCode: string;
  /** Whether this representation is in the public SDK surface. */
  publicDocumentation: boolean;
  /** Whether partners may retry this code. */
  retryable?: boolean;
}

/** Published catalogue shape consumed by the generator. */
interface ErrorCatalogue {
  /** Public and internal code/status representations. */
  representations: readonly ErrorRepresentation[];
}

/** Renders generated TypeScript constants from public catalogue entries. */
export function renderErrorCodes(catalogue: ErrorCatalogue): string;
