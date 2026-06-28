# smart-schema-converter

Typed mapper specs에서 mapper 함수와 JSDoc interface를 생성하는 단일 모듈입니다.

## Why

이 모듈은 DTO와 domain 사이의 변환 코드를 명시적으로 유지하면서도 반복 작성 비용을 줄이기 위해 만들었습니다.

1. 클린 아키텍처 적용 시 보일러플레이트 코드 예방

   API 응답 DTO, DB row, 외부 schema를 domain model로 옮길 때 같은 형태의 mapper 코드가 계속 생깁니다. `defineMap()`으로 필드 이동 규칙만 선언하고, `makeMapper()`와 transformer가 실제 mapper 함수를 만들게 해서 반복 구현을 줄입니다.

2. DTO <-> domain 추적 용이성 향상

   각 domain 필드가 DTO의 어느 path에서 왔는지 `source("profile.name")`처럼 한 곳에 남습니다. `dtoDescription`, `dtoOrigin`, domain property JSDoc을 함께 쓰면 생성된 JSDoc에서 DTO path, DTO 설명, domain 타입을 같이 확인할 수 있어 변경 영향 추적이 쉬워집니다.

3. 기본값 설정을 통한 에러 발생 방지

   외부 입력은 누락될 수 있습니다. `defaultValue`를 지정하면 DTO path 값이 `undefined`일 때 안전한 기본값으로 매핑할 수 있습니다. 단, `null`, `0`, `""`처럼 실제로 전달된 값은 덮어쓰지 않습니다.

## Install

```sh
npm i smart-schema-converter typescript
```

## Mapper

mapper는 DTO 모양을 domain 모양으로 바꾸는 선언입니다.

- `TDto`: API 응답, DB row, 외부 입력처럼 원본 데이터 타입입니다.
- `TDomain`: 앱 내부에서 쓰고 싶은 결과 타입입니다.
- `defineMap<TDto, TDomain>()({...})`: domain 필드별로 DTO의 어디에서 값을 가져올지 선언합니다.
- `source("path.to.value")`: DTO path 값을 그대로 사용합니다.
- `transform("path.to.value", fn)`: DTO path 값을 읽은 뒤 변환해서 사용합니다.
- `makeMapper(map)`: 선언한 map을 실제 함수 `(dto) => domain`으로 만듭니다.

```ts
import { defineMap, makeMapper, source, transform } from "smart-schema-converter";

type UserDto = {
  user_id: string;
  profile: { name: string };
  age: number;
};

type User = {
  id: string;
  name: string;
  ageLabel: string;
};

const userMap = defineMap<UserDto, User>()({
  id: source("user_id"),
  name: source("profile.name"),
  ageLabel: transform("age", (value) => `${value} years`, {
    domainDescription: "Formatted age label.",
  }),
});

export const toUser = makeMapper<UserDto, User>(userMap);
```

`makeMapper`는 transformer 없이도 런타임 fallback으로 동작합니다. Vite plugin이나
`tsTransformer`를 사용하면 `makeMapper<TDto, TDomain>(spec)` 호출이 build time에
plain mapper 함수로 인라인 생성됩니다.

transformer는 직접 호출 형태만 지원합니다. `makeMapper<TDto, TDomain>(spec)`는
변환되지만, namespace 호출이나 alias 호출은 변환하지 않습니다.

```ts
makeMapper<UserDto, User>(userMap); // transformed
schema.makeMapper<UserDto, User>(userMap); // not transformed
toMapper<UserDto, User>(userMap); // not transformed
```

### DTO path

`source()`와 `transform()`의 첫 번째 인자는 DTO에서 값을 읽을 path입니다.
객체는 `.`으로 내려가고, 배열은 숫자 index를 사용할 수 있습니다.

```ts
source("user_id");          // dto.user_id
source("profile.name");     // dto.profile.name
source("items.0.id");       // dto.items[0].id
```

path는 `TDto` 기준으로 타입 체크됩니다. 존재하지 않는 path를 넣으면 TypeScript가
잡아주는 것이 목표입니다.

### Rule options

`source()`와 `transform()`의 마지막 인자로 mapper metadata를 줄 수 있습니다.
metadata는 mapper 실행과 JSDoc 생성에 함께 사용됩니다.

```ts
source("user_id", {
  dtoOrigin: "users.id",
  dtoDescription: "API user identifier",
  domainDescription: "User id",
  defaultValue: "unknown",
});
```

| Option | Type | Used by | Meaning |
| --- | --- | --- | --- |
| `dtoOrigin` | `string` | JSDoc | DTO 값의 원천/출처입니다. 예: API 필드명, DB column, 외부 schema path. 생성 JSDoc의 `DTO origin`으로 기록됩니다. |
| `dtoDescription` | `string` | JSDoc | DTO 필드가 외부 시스템에서 어떤 의미인지 설명합니다. 생성 JSDoc의 `DTO description`으로 기록됩니다. |
| `domainDescription` | `string` | JSDoc | domain 필드 설명 fallback입니다. domain type property JSDoc이 있으면 그 JSDoc이 우선합니다. |
| `defaultValue` | `TValue` | Mapper | DTO path 값이 `undefined`일 때 mapper가 사용할 기본값입니다. `null`, `0`, `""`에는 적용되지 않습니다. |

`transform()`도 같은 metadata를 받습니다. 두 번째 인자인 변환 함수는
`(value, dto)` 형태이며, `value`는 DTO path에서 읽은 값입니다.

```ts
transform(
  "age",
  (value, dto) => `${value} years`,
  {
    dtoDescription: "Raw age from the API",
    domainDescription: "Formatted age label",
  }
);
```

### makeMapper options

`makeMapper(spec, options)`에는 mapping policy 옵션을 줄 수 있습니다. policy는
같은 DTO path가 프로젝트 안에서 어떤 domain field 이름으로 매핑되어야 하는지
고정하는 용도입니다.

```ts
import { defineMappingPolicy, makeMapper, source } from "smart-schema-converter";

const userPolicy = defineMappingPolicy<UserDto>()({
  id: source("user_id"),
});

const toUser = makeMapper<UserDto, User>(userMap, {
  policy: userPolicy,
  policyMode: "error",
});
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `policy` | `MappingPolicy<TDto>` | `undefined` | DTO path별 표준 domain field 이름입니다. |
| `policyMode` | `"warn" \| "error"` | `"warn"` | policy 위반 시 console warning만 낼지, error를 throw할지 정합니다. |

## Vite

```ts
import { vitePlugin as smartSchemaConverter } from "smart-schema-converter";

export default {
  plugins: [
    smartSchemaConverter({
      docs: {
        include: "src/**/*.mapper.ts",
      },
    }),
  ],
};
```

### Vite plugin options

```ts
smartSchemaConverter({
  mapper: true,
  docs: {
    include: "src/**/*.mapper.ts",
    generatedFileName: "smart-schema.generated.ts",
    sourceSuffix: "Source",
    policyMode: "warn",
  },
});
```

Vite dev server에서는 `docs.include`에 매칭되는 mapper 파일이 바뀔 때마다
JSDoc 파일을 다시 생성합니다. 예를 들어 `defineMap()` 내부의 `source()` path,
metadata, domain type suffix가 바뀌면 다음 hot update에서
`smart-schema.generated.ts`도 갱신됩니다.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `mapper` | `boolean` | `true` | `makeMapper<TDto, TDomain>(spec)` 호출을 build time에 plain mapper 함수로 바꿉니다. |
| `docs` | `boolean \| object` | `undefined` | mapper 파일을 스캔해 JSDoc interface 파일을 생성합니다. |

`docs` object options:

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `include` | `string \| string[]` | `["**/*.mapper.ts", "**/*.mapper.tsx"]` | 스캔할 mapper 파일 glob입니다. |
| `exclude` | `string \| string[]` | generated file glob | 스캔에서 제외할 파일 glob입니다. |
| `sourceSuffix` | `string` | `"Source"` | JSDoc 생성 대상 domain type suffix입니다. `UserSource`는 `User` interface로 생성됩니다. |
| `generatedFileName` | `string \| (context) => string` | `"smart-schema.generated.ts"` | 생성할 파일명입니다. mapper 파일과 같은 폴더에 생성됩니다. |
| `outDir` | `"near-source"` | `"near-source"` | 현재는 mapper 파일 옆 생성만 지원합니다. |
| `policyMode` | `"warn" \| "error"` | `"warn"` | docs convention 또는 policy 위반을 warning으로 처리할지 error로 처리할지 정합니다. |

## JSDoc Generation

JSDoc 생성기는 `defineMap<TDto, TDomainSource>()(...)` 선언을 찾고, 기본적으로
`Source` suffix를 제거한 interface를 mapper 파일 옆의
`smart-schema.generated.ts`에 생성합니다.

```ts
type SearchAddressDto = {
  RESULT: { ID: string; TITLE: string };
};

type SearchAddressSource = {
  /** Address id */
  id: string;
  /** Display title */
  title: string;
};

const addressMap = defineMap<SearchAddressDto, SearchAddressSource>()({
  id: source("RESULT.ID", {
    dtoDescription: "Address identifier from the API response.",
    dtoOrigin: "address.id",
  }),
  title: source("RESULT.TITLE"),
});
```

Generated:

```ts
export interface SearchAddress {
  /**
   * Address id
   *
   * - DTO: `SearchAddressDto.RESULT.ID`
   * - DTO description: Address identifier from the API response.
   * - DTO type: `string`
   * - DTO origin: `address.id`
   * - Domain type: `string`
   */
  id: string;
}
```
