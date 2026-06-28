import { getByPath } from "./path.js";

type Primitive =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | Date;

export type PathOf<T> = T extends Primitive
  ? never
  : T extends readonly (infer U)[]
    ? `${number}` | `${number}.${PathOf<U>}`
    : {
        [K in Extract<keyof T, string>]: T[K] extends Primitive
          ? K
          : T[K] extends readonly (infer U)[]
            ? K | `${K}.${number}` | `${K}.${number}.${PathOf<U>}`
            : K | `${K}.${PathOf<T[K]>}`;
      }[Extract<keyof T, string>];

export type Mapper<TDto, TDomain> = (dto: TDto) => TDomain;

export type MapperMetadata<TValue = never> = {
  dtoOrigin?: string;
  domainDescription?: string;
  dtoDescription?: string;
  defaultValue?: TValue;
};

export type MapRule<TDto, TValue> = MapperMetadata<TValue> & {
  from: PathOf<TDto>;
  transform?: (value: unknown, dto: TDto) => TValue;
};

export type MapSpec<TDto, TDomain> = {
  [K in keyof TDomain]-?: MapRule<TDto, TDomain[K]>;
};

export type MappingPolicy<TDto> = Record<string, MapRule<TDto, unknown>>;
export type MappingPolicyMode = "warn" | "error";

export type MapperOptions<TDto> = {
  policy?: MappingPolicy<TDto>;
  policyMode?: MappingPolicyMode;
};

declare const DTO_TYPE: unique symbol;
declare const DOMAIN_TYPE: unique symbol;

export type DefinedMap<TDto, TDomain> = MapSpec<TDto, TDomain> & {
  readonly [DTO_TYPE]?: TDto;
  readonly [DOMAIN_TYPE]?: TDomain;
};

export function defineMap<TDto, TDomain>() {
  return <const TSpec extends MapSpec<TDto, TDomain>>(spec: TSpec) =>
    spec as TSpec & DefinedMap<TDto, TDomain>;
}

export function defineMappingPolicy<TDto>() {
  return <const TSpec extends MappingPolicy<TDto>>(spec: TSpec) => spec;
}

export function source<const TPath extends string, TValue = never>(
  from: TPath,
  metadata?: MapperMetadata<TValue>
) {
  return { from, ...metadata };
}

export function transform<const TPath extends string, TValue>(
  from: TPath,
  transform: (value: unknown, dto: unknown) => TValue,
  metadata?: MapperMetadata<TValue>
) {
  return { from, transform, ...metadata };
}

export function mapperHelpers<TDto>() {
  return {
    source: <const TPath extends PathOf<TDto>, TValue = never>(
      from: TPath,
      metadata?: MapperMetadata<TValue>
    ) => source(from, metadata),
    transform: <const TPath extends PathOf<TDto>, TValue>(
      from: TPath,
      transform: (value: unknown, dto: TDto) => TValue,
      metadata?: MapperMetadata<TValue>
    ) => ({ from, transform, ...metadata }),
  };
}

export function makeMapper<TDto, TDomain>(
  spec: DefinedMap<TDto, TDomain> | MapSpec<TDto, TDomain>,
  options?: MapperOptions<TDto>
): Mapper<TDto, TDomain> {
  handleRuntimePolicyViolations(
    findRuntimePolicyViolations(spec, options?.policy),
    options?.policyMode ?? "warn"
  );

  return ((dto: TDto) => {
    const output: Record<string, unknown> = {};

    for (const key of Object.keys(spec)) {
      const rule = (spec as Record<string, MapRule<TDto, unknown>>)[key];
      const raw = getByPath(dto, String(rule.from));
      const value = raw === undefined && hasOwn(rule, "defaultValue") ? rule.defaultValue : raw;
      output[key] = rule.transform ? rule.transform(value, dto) : value;
    }

    return output as TDomain;
  }) as Mapper<TDto, TDomain>;
}

export function findRuntimePolicyViolations<TDto>(
  spec: MapSpec<TDto, unknown>,
  policy: MappingPolicy<TDto> | undefined
): string[] {
  if (!policy) return [];

  const canonicalByPath = new Map<string, string>();
  const violations: string[] = [];

  for (const key of Object.keys(policy)) {
    const from = String(policy[key].from);
    const existing = canonicalByPath.get(from);
    if (existing && existing !== key) {
      violations.push(
        `DTO path "${from}" is canonically mapped as "${existing}", but this map uses "${key}".`
      );
      continue;
    }
    canonicalByPath.set(from, key);
  }

  for (const key of Object.keys(spec)) {
    const from = String((spec as Record<string, MapRule<TDto, unknown>>)[key].from);
    const expected = canonicalByPath.get(from);
    if (expected && expected !== key) {
      violations.push(
        `DTO path "${from}" is canonically mapped as "${expected}", but this map uses "${key}".`
      );
    }
  }

  return violations;
}

export function handleRuntimePolicyViolations(
  violations: string[],
  mode: MappingPolicyMode
): void {
  if (!violations.length) return;

  const message = `[smart-schema-converter/mapper] Mapping policy violation:\n${violations.join("\n")}`;
  if (mode === "error") throw new Error(message);
  console.warn(message);
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
