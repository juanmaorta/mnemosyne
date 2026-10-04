# Dreaming — relajar local-first (opt-in) para un modelo mayor

> Estado: 2026-10-04 (MNE-83). Mecanismo implementado; aplicación real (MNE-46) sigue bloqueada.

Dreaming es **local-first por defecto**: la generación de síntesis habla con Ollama en
`localhost`. La evaluación (MNE-80/84) mostró que un modelo local pequeño (qwen2.5:7b) no
consolida bien casos densos, y un modelo local mayor exige RAM que no todo el mundo tiene.
Para no excluir a esos usuarios, se puede **optar explícitamente** por un endpoint mayor en
cloud o en infra propia — **sin** que eso sea el comportamiento por defecto y **sin** que un
ajuste lo active por accidente.

## Cómo se activa

Fichero **machine-local** en la raíz del store: `~/memory/.dreaming.json`. No se sincroniza
(como `.owner`/`.scopemap`): optar por remoto es una decisión **de esta máquina**, no viaja
con las memorias.

```jsonc
{
  "remote": {
    "endpoint": "https://ollama.com",       // tu cloud o tu GPU en LAN/VPN
    "model": "gemma4:31b-cloud",            // modelo en ese endpoint
    "apiKeyEnv": "OLLAMA_API_KEY",          // env var con el Bearer token (NO la clave)
    "allowScopes": ["personal"]             // SOLO estos scopes salen
  }
}
```

La clave **no** se guarda en el fichero: `apiKeyEnv` nombra la **variable de entorno** de la
que leerla. Si el endpoint está opted-in y la env var falta, falla cerrado (no llama, no cae a
local). La clave solo se envía como `Authorization: Bearer` en el path remoto; nunca se
escribe en disco, logs, telemetría ni frontmatter.

Sin fichero, o mal formado, o `allowScopes` vacío → **todo sigue local** (fail-closed).

## Garantías (no negociables)

- **Boundary de scope.** Un scope que no esté en `allowScopes` **nunca** sale de la máquina,
  aunque haya `endpoint` configurado. Un scope de cliente (p.ej. `acme`) no se filtra a un
  remoto no aprobado para él.
- **Egreso de secretos.** Antes de cualquier llamada remota, el prompt+system se pasa por el
  escáner de secretos; una clave/token/clave privada (reject-level) **aborta** el envío. Las
  llamadas locales no se gatean aquí (el contenido no sale de la máquina; el gate de secretos
  de escritura sigue aplicando a lo que se guarda).
- **Loopback = local.** Un `endpoint` que resuelva a loopback (`localhost`/`127.0.0.1`/`::1`)
  se trata como local, no como remoto. A la inversa, un `OLLAMA_HOST` que apunte **fuera** de
  la máquina **no** se usa como "local" sin opt-in: el camino sin opt-in es siempre loopback,
  para que una variable de entorno no se convierta en una fuga silenciosa que no pasó el gate
  de scope. Para usar un Ollama en tu LAN/VPN, decláralo en `allowScopes`.
- **Solo generación.** Embeddings y retrieval siguen siendo locales siempre; esto afecta
  únicamente a la generación de dreaming.

## Trade-off

| | Local (por defecto) | Remoto (opt-in) |
|---|---|---|
| Privacidad | el contenido no sale de la máquina | las memorias del scope salen a tu endpoint |
| Coste | gratis (tu hardware) | coste del proveedor / tu infra |
| Calidad | limitada por el modelo local | modelo mayor → mejor cobertura densa |
| RAM | necesitas RAM para el modelo | no necesitas RAM local |

La decisión es del usuario, por scope, y reversible borrando o editando `.dreaming.json`.
