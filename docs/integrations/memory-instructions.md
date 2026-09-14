# Bloque de instrucciones de memoria (agent-agnostic)

Qué es: el texto que se pega tal cual en `~/.claude/CLAUDE.md` (Claude Code) y en el
`AGENTS.md` que lea OpenCode. Es el mismo bloque para los dos: no menciona ningún
harness y solo usa comandos reales del CLI `mneme`.

Cómo se activa: [`canonical-memory-cutover.md`](canonical-memory-cutover.md). Decisión
y alcance: [`../superpowers/plans/2026-09-11-canonical-memory-cutover.md`](../superpowers/plans/2026-09-11-canonical-memory-cutover.md).

Todos los ejemplos funcionan literalmente contra el CLI actual (sustituyendo los
`<placeholders>`). Al editarlo, verificar los flags contra `src/cli.ts` antes de tocar
nada: un flag inventado aquí se convierte en una escritura que el agente cree hecha.

---

## Bloque (copiar entero)

````md
## Memoria duradera — Mnemosyne (CLI `mneme`)

La memoria duradera vive en `~/memory` y se accede solo con `mneme`. No crees ni uses
otro store de memoria, incluida la memoria nativa del harness.

Al empezar a trabajar en un proyecto:

```sh
mneme context --cwd /ruta/real/del/proyecto
```

Antes de asumir algo, y antes de crear una nota sobre un tema que puede existir ya:

```sh
mneme search "<tema>"          # devuelve refs + snippet, NO el documento
mneme get <slug>               # contenido completo; search no equivale a leerlo
```

Guarda en cuanto aparece —preferencia, corrección, restricción reutilizable—, no solo al
final de la sesión. No guardes código ni nada derivable de git (ramas, autores, diffs,
historial): eso ya está en el repositorio.

```sh
# Observación nueva (feedback es append-only: cada observación es un hecho nuevo,
# con su propio slug; reutilizar un slug ya usado en ese scope se rechaza, exit 1)
mneme add "<observación>" --type feedback --slug <slug-nuevo> --cwd /ruta/real/del/proyecto

# Nota autorada nueva
mneme add "<contenido>" --type reference --slug <slug-estable> --cwd /ruta/real/del/proyecto
```

`--type` es obligatorio: `feedback` (hecho append-only) | `reference` | `project` | `user`
(notas autoradas, editables). Un cuerpo que empieza por `-` (una lista con viñetas) no
puede ir como posicional suelto: usa `--file`, o ponlo detrás de `--` con los flags delante
(`mneme add --type reference --slug <slug> -- "- uno"`). Para cuerpos largos, `--file` con
un fichero que contenga SOLO el cuerpo, nunca frontmatter (pasar texto posicional y
`--file` a la vez es error):

```sh
mneme add --file /tmp/cuerpo.md --type project --slug <slug-estable> --cwd /ruta/real/del/proyecto
```

Para cambiar una nota autorada existente: leer, reconciliar, escribir contra la revisión leída.

```sh
mneme get <slug> --json        # imprime un objeto: {slug, scope, path, content, revision}
mneme update <slug> "<cuerpo nuevo>" --if-match <revision> --cwd /ruta/real/del/proyecto
```

`--if-match` es obligatorio y no existe `--force`. Si responde
`conflict: <slug> changed since you read it`, otro escritor ganó: vuelve a
`mneme get <slug> --json`, reconcilia tu cambio contra ese contenido y actualiza con la
revisión nueva. Nunca reintentes con otra revisión sin releer, ni dupliques la nota.

Un `feedback` no se actualiza: se añade uno nuevo (`mneme add ... --type feedback`).

Reglas que no se negocian:

- Pasa `--slug` en cada `add`: es la identidad de la nota. `update` recibe el slug como
  argumento posicional, no como flag, y `context` no lo acepta en ninguna forma.
- Pasa `--cwd` con el cwd real de la sesión a `add`, `update` y `context`. Sin él el scope
  se resuelve contra el directorio del proceso, que puede no ser el del proyecto.
- No inventes flags. `add` y `update` fallan con `Unknown option '--x'` y exit 1, pero
  `context` se traga el error y devuelve un digest VACÍO del scope por defecto con exit 0:
  parecerá que no hay memoria cuando lo que hay es un comando mal escrito.
- Si el cwd no mapea a ningún scope, la escritura falla a propósito
  (`cannot resolve a scope for this cwd`). Pregunta a qué scope corresponde; no concluyas
  que es `personal` solo porque no mapea.
- Una nota recién creada aún no está indexada: `mneme get` no la encontrará hasta que
  corras `mneme search "<tema>"` (reindexa antes de buscar) o `mneme reindex`.
- Si guardar falla, dilo citando el error. Nunca afirmes que se ha guardado, y nunca
  escribas como fallback en la memoria nativa ni en otro fichero.
````

---

## Notas para quien mantiene el bloque

- **Por qué `--slug` solo en `add`.** Sin `--slug`, el slug se deriva de la description completa
  y produce nombres de fichero inservibles. Para notas autoradas el slug es la identidad
  que luego usa `update`; para `feedback`, cada hecho necesita el suyo porque el índice
  impone unicidad `(scope, slug)`. Un slug ya reclamado en ese scope se rechaza en la
  escritura (`slug '<slug>' is already claimed in scope '<scope>' by <path>`, exit 1, nada
  en disco): antes el segundo fichero se escribía y quedaba sin indexar, visible solo como
  `errors 1` en `mneme reindex`.
- **Por qué el aviso del cuerpo con `-`.** `parseArgs` (node) rechaza un posicional que
  empiece por `-` antes de que el comando lea nada: `Unknown option '- '` y exit 1. Con la
  regla de "si guardar falla, dilo", el agente reporta un fallo de guardado por una comilla
  mal puesta. `--file` y `--` son las dos formas que sí funcionan.
- **Por qué `get` después de `search`.** `search` devuelve score + slug + snippet, no el
  documento. `get` lee el `.md` entero (frontmatter incluido) y refuerza la memoria.
- **Por qué el aviso del índice.** `get` resuelve el slug contra el índice SQLite del store
  (`<root>/.index/store.db`, con `<root>` = `MNEMOSYNE_ROOT` o `~/memory`), que es estado
  derivado; `search` y `context` reindexan de forma perezosa antes de consultar, `get` no.
- **Por qué la regla de no inventar flags.** `add` y `update` dejan que `parseArgs` falle y
  devuelven exit 1, pero `context` envuelve todo su cuerpo en un catch que no puede fallar
  (`src/cli.ts:189-195`): un flag desconocido allí produce un digest vacío del scope por
  defecto, exit 0 y solo un `warning: memory digest degraded (fatal)` en stderr.
- **Por qué no hay `--force`.** Un `update` es un compare-and-swap sobre los bytes del
  fichero. La única recuperación correcta de un conflicto es releer y reconciliar; ver
  `src/write/update.ts`.
