# Diagnóstico — la suite se cuelga en GitHub Actions, 2026-09-20

> **Sin resolver.** Tres hipótesis formuladas y refutadas; la cuarta está sin probar. Este
> documento existe para que el siguiente intento empiece donde acabó este y no repita los
> experimentos ya hechos — cada uno cuesta 15 minutos de una cuota gratuita.
>
> Contexto: el workflow de CI (MNE-24,
> PR [#25](https://github.com/juanmaorta/mnemosyne/pull/25)) no ha pasado nunca en verde.
> Runner: `ubuntu-latest`, cuenta gratuita, repo privado → **2 vCPU / 7 GB**. Node 24.
> Local: MacBook/Mac Mini, 12 núcleos, la misma suite en **13 segundos**.
>
> Repro y comandos: [Apéndice A](#apéndice-a--reproducir).

---

## 0. Resumen

`npm test` **no termina** en el runner. Arranca, completa 18 ficheros de test en unos 45
segundos, y a partir de ahí no emite una sola línea hasta que el job muere. Al matarlo
quedan procesos huérfanos: `npm test`, un `sh` y dos procesos de vitest.

El hecho que ordena todo el diagnóstico es que **es determinista**: no falla un test
distinto cada vez ni tarda un poco más, sino que se detiene **siempre en el mismo punto**,
tras exactamente los mismos 18 ficheros. Eso descarta de entrada la explicación cómoda
—"el runner va justo de CPU"—, que produciría lentitud variable, no un corte reproducible.

El fichero 19 de la cola es trivial. **El problema no es ningún test: es que el pool de
vitest deja de repartir trabajo.**

## 1. Los hechos medidos

| Observación | Valor |
|---|---|
| Duración local de la suite | ~13 s (462 tests a 2026-09-20) |
| Ficheros que completan en el runner | 18, siempre los mismos |
| Tiempo hasta pararse | ~45 s |
| Silencio posterior antes del corte | 11+ min, cero líneas |
| Huérfanos al matar el job | `npm test`, `sh`, 2× vitest |
| Runs consumidos en el diagnóstico | 7 (~100 min de cuota) |

Un matiz que cambió el análisis a mitad de camino: el primer run se dejó correr **más de
cinco horas** antes de cancelarlo a mano. De ahí salió `timeout-minutes: 15` en el
workflow, que no arregla nada pero convierte un cuelgue silencioso en un fallo acotado.

## 2. Lo que está descartado

Cada línea es un experimento hecho, no una intuición.

| Hipótesis | Cómo se descartó |
|---|---|
| **Un test lento** | Los 18 acaban en 45 s y luego no se emite nada en once minutos. La lentitud no produce silencio absoluto. |
| **Falta de CPU** | En local con `--maxWorkers=2` la suite **falla** (el flake de MNE-41) pero **termina**. Síntoma distinto. |
| **Algún proceso esperando en stdin** | No hay ninguna lectura de stdin en el código de producción anterior a MNE-69 (`grep` sobre `readFileSync(0` / `process.stdin`), y el cuelgue es anterior a esa rama. |
| **Paralelismo entre ficheros** | Con `--no-file-parallelism` se para en el mismo sitio exacto. |
| **El `globalSetup` construyendo `dist`** | Era la hipótesis principal: el `globalSetup` lanza `npm run build` como proceso hijo cuando `dist` falta, y en CI falta siempre, mientras que en local casi nunca. Se movió el build a su propio step: **el build pasa y `npm test` se sigue colgando**. Refutada. |
| **`Atomics.wait` congelando el pool de hilos** | La ruta de escritura es síncrona y espera al lock de scope con `Atomics.wait` (`src/write/lock.ts:52`), que no cede el hilo. Con dos workers, un worker congelado es medio pool. Se probó `--pool=forks`, donde un proceso bloqueado no puede congelar a otro: **mismo punto de parada**. Refutada. |

De los dos últimos cambios, uno se quedó y otro se revirtió. El build como step propio se
mantiene porque hace legible un fallo de build aunque no arregle el cuelgue; `--pool=forks`
se revirtió, porque dejarlo sería divergencia entre CI y local sin beneficio demostrado.

## 3. La pista: dónde se para exactamente

Vitest, sin caché de duraciones —que es siempre el caso en un checkout limpio—, encola los
ficheros **por tamaño, de mayor a menor**. El orden se calculó en local (`Apéndice A`) y se
contrastó con los que sí terminan en el runner:

**Los 18 que completan son exactamente los 18 ficheros de test más grandes.** Coincidencia
total, sin un solo fichero fuera de sitio. Es decir, la ejecución no se para en un fichero
concreto por lo que ese fichero hace, sino **en una posición fija de la cola**:

| # | Fichero | |
|---|---|---|
| 1–18 | los 18 mayores | ✅ completan |
| **19** | `src/telemetry/events.test.ts` | ⛔ nunca reporta |
| 20 | `src/write/add.test.ts` | el otro en vuelo con 2 workers |

Y el 19 es de los más simples del repo: un `mkdtemp` y un `appendFileSync`. Sin timers, sin
procesos hijo, sin red, sin locks. **No hay nada ahí que pueda bloquearse.**

Un aviso para quien repita esto: la frontera es estrechísima. El 18 pesa 5.914 bytes y el
19 pesa 5.899 — **quince bytes**. Editar cualquier test cercano reordena la cola y cambia
qué ficheros caen a cada lado, así que el orden hay que recalcularlo en el mismo commit que
se esté diagnosticando, no dar por bueno el de aquí.

Se comprobó además por el otro lado: ejecutando **solo** los 35 ficheros que nunca llegan a
correr, vitest imprime su banner `RUN` y no emite absolutamente nada en 12 minutos. Sin los
pesados delante, los ligeros tampoco arrancan.

## 4. Hipótesis viva, sin probar

Los 18 primeros son, por tamaño, precisamente los que **lanzan procesos hijo**:
`concurrency.test.ts` arranca 8 procesos por test, `canonical-memory.integration.test.ts`
ejecuta el CLI compilado con `execFile`, y los `cli.*` hacen lo propio. Solo la suite de
concurrencia son del orden de 40 procesos.

La hipótesis es que **algo no se libera al terminar cada fichero** —procesos, descriptores,
memoria del runner— y al llegar al 19 ya no queda de eso, de modo que el pool no puede
arrancar el siguiente worker y se queda esperando sin error ni mensaje.

Encaja con todo lo observado: es determinista (se agota siempre tras el mismo trabajo), no
lo cambia ni serializar ni cambiar de tipo de pool (el trabajo total es el mismo), y no
aparece en local, donde hay doce núcleos y otros límites de recursos.

Es una hipótesis, no un diagnóstico. **No se ha probado.**

## 5. Cómo confirmarla, y cómo no

**Cómo no:** iterando contra Actions. Cada ciclo son 15 minutos de una cuota gratuita, y el
diagnóstico ya se llevó del orden de 100.

**Cómo sí:** reproduciendo Linux en local con Docker y midiendo mientras corre.

1. Contenedor Linux con **`--cpuset-cpus=0,1`**, no `--cpus=2`: este último limita el
   *tiempo* de CPU pero deja `nproc` en 12, así que vitest arranca doce workers y el
   escenario deja de parecerse al runner.
2. Memoria con holgura respecto a la VM de Docker (`docker info` → `MemTotal`). Pedir casi
   toda la VM cuelga el demonio; ocurrió.
3. Clonar el repo **dentro** del contenedor y hacer `npm ci` allí: los bindings nativos de
   `better-sqlite3` y `sqlite-vec` del host son de otra arquitectura.
4. Con la suite corriendo, muestrear en paralelo `ps -eo pid,stat | wc -l`, `lsof | wc -l`
   y memoria, y ver si alguna curva toca un techo justo cuando el reporter calla.
5. Si el techo aparece: el fix va en los tests que dejan recursos vivos, no en el workflow.
   Si no aparece: la hipótesis cae y hay que volver al punto 3 de este documento, que es lo
   único firme que tenemos.

## 6. Qué hay en el PR #25 que vale igualmente

Aunque el cuelgue siga abierto, lo que trae el PR se sostiene solo:

- El workflow (`npm ci`, typecheck, build, tests) en `push` a `main` y en cada PR.
- **`timeout-minutes: 15`**: sin él, un cuelgue se come el límite por defecto de seis horas.
- El build como step propio, antes de los tests: un fallo de build se lee como fallo de
  build y no como una suite muda.
- Badge en el README.

Lo que **no** trae es un run en verde. Mergearlo instala una puerta que hoy no cierra.

---

## Apéndice A — reproducir

**El orden de la cola** (lo que permitió identificar la posición 19):

```sh
find src -name "*.test.ts" -exec stat -f "%z %N" {} \; | sort -rn | cat -n
```

En Linux, `stat -c "%s %n"`. Los 18 primeros deben coincidir con los que completan en el
runner.

**Qué ficheros completan en un run** (con el reporter por defecto, que imprime una línea
por fichero terminado):

```sh
gh run view --log --job=<id> | sed 's/\x1b\[[0-9;]*m//g' | grep -oE "src/[a-zA-Z0-9./_-]*\.test\.ts" | sort -u
```

Ojo con este comando si se pasa una lista de ficheros en la línea del step: el `grep`
captura también los argumentos del propio comando y parece que reportaron cuando no lo
hicieron. Pasó, y mandó el análisis por el camino equivocado durante un rato.

**Simular el runner en local, sin Linux** (no reproduce el cuelgue, pero sí el flake de
MNE-41):

```sh
npx vitest run --maxWorkers=2
```

**Ver qué se queda vivo** al final de un run de Actions: la sección `Cleaning up orphan
processes` del log, que enumera lo que el runner tuvo que matar.
