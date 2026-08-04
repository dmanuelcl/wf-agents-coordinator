# Agent Coordinator remoto

Esta carpeta contiene todo lo necesario para desplegar el **runner remoto**.
El runner conserva proyectos, worktrees, sesiones, PTYs y credenciales de los
agentes en una máquina; la interfaz se abre desde el navegador o desde la app
desktop conectada a esa máquina.

## ¿macOS o Linux?

Los dos son compatibles.

| Dónde corre el runner | Úsalo para | Servicio persistente |
| --- | --- | --- |
| Tu Mac de 48/32 GB | Empezar ahora, sin comprar VPS | `launchd` (`com.agent-coordinator.runner.plist`) |
| Un servidor Linux | Uso permanente con mucha RAM/disco | `systemd` (`agent-coordinator-runner.service`) |

No hay diferencia funcional: el código, las sesiones y la URL pública son los
mismos. Linux es una recomendación operativa para un servidor dedicado, no un
requisito. Para la primera prueba, usa tu Mac más potente.

## ¿Tailscale o Cloudflare Tunnel?

El runner escucha **sólo en `127.0.0.1:4765`** y nunca se debe exponer
directamente. Delante va un proxy, y hay dos opciones soportadas:

| | **Tailscale Serve** | **Cloudflare Tunnel** |
| --- | --- | --- |
| URL | `https://maquina.tu-tailnet.ts.net` | **tu propio dominio**, p. ej. `https://coordinator.tudominio.com` |
| Quién puede llegar | sólo dispositivos de tu tailnet | **todo Internet** (salvo que pongas Cloudflare Access delante) |
| Requiere | Tailscale en runner y cliente | una cuenta de Cloudflare con tu dominio |
| Cliente sin instalar nada | no (el dispositivo debe estar en el tailnet) | sí, cualquier navegador |
| Autenticación | la red misma, más el token | el token, más Access si lo configuras |

Usa **Tailscale** si te vale una URL privada: es el camino más corto y el más
seguro por defecto. Usa **Cloudflare Tunnel** si quieres dominio propio o
entrar desde un dispositivo que no puede unirse al tailnet — asumiendo el
punto de seguridad que se explica en el Paso 4B.

Ambas rutas terminan igual: abres la URL, escribes el token y trabajas.

## Qué queda en cada máquina

```text
Mac/servidor que ejecuta el runner
  ├─ repositorios y worktrees
  ├─ agentes y sus OAuth (Codex, Claude, etc.)
  ├─ estado de Coordinator, intentos de terminal y scrollback
  └─ Tailscale Serve  ó  cloudflared → URL HTTPS

Tu laptop/iPad/navegador
  └─ sólo la interfaz; no conserva agentes ni repositorios
```

El proxy es lo único que cruza la red. El runner escucha únicamente en
`127.0.0.1:4765`: no se abre ningún puerto del router, y `cloudflared` o
`tailscaled` corren en esa misma máquina y se conectan al loopback.

## Antes de empezar

En la máquina que será runner necesitas:

- este repositorio en la rama `feature/remote-coordinator`;
- Node, pnpm, Git, y **Tailscale o `cloudflared`** según la opción que elijas;
- los CLIs de los agentes que quieras usar;
- herramientas de compilación nativa. En Ubuntu/Debian: `sudo apt-get install
  -y build-essential python3`;
- iniciar sesión en cada agente **como el mismo usuario que ejecutará el
  runner**. Para Codex, puedes ejecutar `codex login --device-auth` en esa
  máquina y completar la URL/código desde tu navegador habitual.

No copies `.codex`, `.claude` ni tokens desde otro equipo salvo que tú decidas
migrarlos. Lo normal es autenticar cada host una sola vez.

## Paso 1: construir el runner

En la máquina runner:

```sh
cd /ruta/a/AGENTS
git switch feature/remote-coordinator
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --ignore-scripts
pnpm remote:build
```

El runner remoto usa Node directamente: no descarga, no arranca ni necesita el
binario de Electron. `pnpm remote:build` fuerza la compilación nativa de
`node-pty` y `better-sqlite3` para la versión de Node de esa máquina, y produce
`out/main/remote-runner.js` junto a la interfaz web que éste sirve.

No sustituyas ese paso por `pnpm rebuild`: después de una instalación con
`--ignore-scripts`, pnpm puede omitir la reconstrucción aunque los binarios
sigan siendo de Electron. El comando del proyecto ejecuta `node-gyp`
directamente para ambos módulos. Si aparece `NODE_MODULE_VERSION` o
`ERR_DLOPEN_FAILED`, ejecuta de nuevo `pnpm remote:build`.

Este checkout queda preparado para el runner de Node. Si también desarrollas o
empaquetas la app Electron en la misma máquina, usa un checkout separado o
ejecuta `pnpm build` antes de volver a abrir Electron: ese comando vuelve a
compilar los módulos nativos para Electron.

Si ya hiciste un `pnpm install` que falló con un error de Electron, ejecuta en
el checkout del runner:

```sh
rm -rf node_modules
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --ignore-scripts
pnpm remote:build
```

Si el runner ya fue construido pero muestra `Failed to load native module:
pty.node`, no reinstales todo; basta con volver a ejecutar `pnpm remote:build`.

## Paso 2: crear la configuración privada

Nunca guardes secretos dentro del repositorio. Copia el ejemplo a una carpeta
privada y edítalo:

```sh
mkdir -p "$HOME/.config/agent-coordinator"
cp deploy/runner.env.example "$HOME/.config/agent-coordinator/runner.env"
chmod 600 "$HOME/.config/agent-coordinator/runner.env"
```

Abre `~/.config/agent-coordinator/runner.env` y reemplaza los cinco valores:

```dotenv
AGENT_COORDINATOR_STATE_DIR=/Users/TU_USUARIO/AgentCoordinatorRunner
AGENT_COORDINATOR_REMOTE_HOST=127.0.0.1
AGENT_COORDINATOR_REMOTE_PORT=4765
AGENT_COORDINATOR_REMOTE_TOKEN=un-token-largo-y-aleatorio
AGENT_COORDINATOR_DATA_KEY=una-clave-base64-de-32-bytes
```

Genera una vez los dos secretos así:

```sh
openssl rand -base64 32
```

Ejecuta el comando dos veces: el primer resultado va en
`AGENT_COORDINATOR_REMOTE_TOKEN` y el segundo en
`AGENT_COORDINATOR_DATA_KEY`. Conserva ambos. La data key cifra los tokens VCS
en disco; cambiarla después impedirá leer los tokens VCS ya guardados.

En Linux cambia la ruta de estado, por ejemplo a:

```dotenv
AGENT_COORDINATOR_STATE_DIR=/srv/agent-coordinator/state
```

## Paso 3: primera prueba, todavía sin proxy

En una terminal nueva de la máquina runner:

```sh
cd /ruta/a/AGENTS
set -a
source "$HOME/.config/agent-coordinator/runner.env"
set +a
pnpm remote:runner
```

Debe aparecer `Agent Coordinator runner listening on 4765.`. Abre
`http://127.0.0.1:4765` en un navegador de esa misma máquina. La pantalla pide:

- **Runner WebSocket URL:** `ws://127.0.0.1:4765/rpc`
- **Connection token:** el valor de `AGENT_COORDINATOR_REMOTE_TOKEN`

Los proyectos que añadas deben ser rutas de la máquina runner. En macOS pueden
ser `/Users/TU_USUARIO/Projects/...`; en Linux `/srv/projects/...`.

Para probar continuidad, inicia un terminal/agente, recarga con F5 o cierra
sólo la pestaña del navegador y vuelve a abrir la URL. El cliente se limita a
mostrar la PTY y enviar tu teclado: ni F5, ni una segunda computadora, ni
cerrar una pestaña reinician setup, agentes, tabs o Auto Pilot.

La pestaña visible puede ajustar únicamente filas y columnas para aprovechar su
pantalla. Es un `SIGWINCH` normal de terminal: no crea ni reinicia procesos,
no reenvía prompts y no cambia el estado de la sesión. Al abrir la misma
terminal en otra pantalla, esa pantalla visible pasa a ser la geometría activa.

## Paso 4: publicar la URL

Elige **una** de las dos. En ambas, `AGENT_COORDINATOR_REMOTE_HOST` se queda en
`127.0.0.1`: el proxy corre en la misma máquina que el runner. Nunca lo
cambies a `0.0.0.0`.

### Paso 4A: URL privada con Tailscale

Con el runner funcionando, en esa misma máquina ejecuta una vez:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:4765
```

Tailscale mostrará la URL `https://nombre-maquina.tu-tailnet.ts.net`. Ábrela
desde cualquier dispositivo que esté conectado a tu Tailnet. La interfaz usa
esa misma URL para el WebSocket seguro; sólo debes introducir el token de
Coordinator. `--bg` guarda la configuración para que Tailscale vuelva a
publicarla tras reiniciar la máquina o Tailscale. No uses `tailscale funnel`:
eso sí publicaría el runner en Internet, y sin el control que da Access.

Para revisar la configuración:

```sh
tailscale serve status
```

### Paso 4B: dominio propio con Cloudflare Tunnel

Útil cuando quieres `https://coordinator.tudominio.com` o entrar desde un
dispositivo que no puede unirse al tailnet. Requiere que el dominio esté en
Cloudflare.

Instala `cloudflared` en la máquina runner (`brew install cloudflared` en
macOS; en Linux el `.deb`/`.rpm` oficial) y autentícalo una vez:

```sh
cloudflared tunnel login
cloudflared tunnel create agent-coordinator
cloudflared tunnel route dns agent-coordinator coordinator.tudominio.com
```

`cloudflared tunnel create` imprime el UUID del túnel y deja el fichero de
credenciales en `~/.cloudflared/<UUID>.json`. Escribe
`~/.cloudflared/config.yml`:

```yaml
tunnel: agent-coordinator
credentials-file: /Users/TU_USUARIO/.cloudflared/UUID-DEL-TUNEL.json

ingress:
  - hostname: coordinator.tudominio.com
    service: http://127.0.0.1:4765
  - service: http_status:404
```

Pruébalo en primer plano y luego instálalo como servicio para que sobreviva a
reinicios:

```sh
cloudflared tunnel run agent-coordinator     # prueba
sudo cloudflared service install             # launchd en macOS, systemd en Linux
```

Abre `https://coordinator.tudominio.com`. La interfaz deduce el WebSocket de la
propia URL (`wss://coordinator.tudominio.com/rpc`), así que sólo escribes el
token.

Los WebSocket vienen habilitados por defecto en hostnames proxied; si alguien
los desactivó en tu cuenta, están en el panel de Cloudflare bajo **Network →
WebSockets**. El runner envía un heartbeat propio para que una conexión inactiva
no se caiga por el timeout del proxy, así que no hace falta configurar nada más.

#### Lo que cambia respecto a Tailscale

Un túnel de Cloudflare publica el runner en **Internet**. A partir de ahí, el
token de Coordinator es lo único que separa al mundo de shells con tus repos y
tus sesiones de agente autenticadas. Dos consecuencias:

1. Usa un token largo y aleatorio (`openssl rand -base64 32`, que es lo que ya
   generaste) y rótalo si crees que se filtró: cámbialo en `runner.env`,
   reinicia el runner y vuelve a conectar los clientes.
2. Pon **Cloudflare Access** delante del hostname (Zero Trust → Access →
   Applications → self-hosted) con una política de correo o SSO. Así Cloudflare
   pide identidad antes de que la petición llegue siquiera al runner.

Advertencia sobre Access y la app desktop: Access autentica en el navegador y
guarda una cookie, así que la vía web funciona bien. La app desktop conectada
con `AGENT_COORDINATOR_REMOTE_URL` **no** lleva esa cookie y Access rechazará su
WebSocket. Si quieres las dos cosas, usa el navegador para la vía protegida por
Access, o deja el hostname fuera de Access y acepta que el token es la única
credencial.

## Mantenerlo encendido tras reiniciar

### macOS: launchd

1. Copia `com.agent-coordinator.runner.plist` a
   `~/Library/LaunchAgents/`.
2. Edita las rutas `CAMBIA_ESTA_RUTA` dentro del archivo: una es el checkout de
   AGENTS y la otra es tu `runner.env`.
3. Crea la carpeta de logs y cárgalo:

   ```sh
   mkdir -p "$HOME/Library/Logs/AgentCoordinator"
   launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.agent-coordinator.runner.plist"
   ```

4. Los logs se escriben en `~/Library/Logs/AgentCoordinator/`.

Para detenerlo: `launchctl bootout "gui/$(id -u)" com.agent-coordinator.runner`.

### Linux: systemd de usuario

1. Copia `agent-coordinator-runner.service` a
   `~/.config/systemd/user/`.
2. Edita `WorkingDirectory`, `EnvironmentFile` y la ruta absoluta de `node` en
   `ExecStart`. Obtén esa ruta desde tu terminal normal con `command -v node`.
   Usa `node .../out/main/remote-runner.js` directamente, no `pnpm`: un
   servicio de systemd no carga NVM ni tu `.bashrc`, y el ejecutable de pnpm
   busca `node` usando su `PATH`.

   Por ejemplo, si usas NVM y `command -v node` devuelve
   `/home/dani/.nvm/versions/node/v24.11.0/bin/node`, las líneas quedan así:

   ```ini
   WorkingDirectory=/home/dani/biznex-project/wf-agents-coordinator
   EnvironmentFile=/home/dani/.config/agent-coordinator/runner.env
   ExecStart=/home/dani/.nvm/versions/node/v24.11.0/bin/node /home/dani/biznex-project/wf-agents-coordinator/out/main/remote-runner.js
   ```

   Si actualizas Node, ejecuta `pnpm remote:build` con ese Node y reemplaza la
   ruta de `ExecStart` por la nueva.
3. Actívalo:

   ```sh
   systemctl --user daemon-reload
   systemctl --user enable --now agent-coordinator-runner
   ```

Para que siga vivo después de cerrar sesión:

```sh
loginctl enable-linger "$USER"
```

Logs: `journalctl --user -u agent-coordinator-runner -f`.

## Desktop remoto (opcional)

La vía más simple es la web. Si prefieres la app desktop, arráncala indicando
la URL y token remotos. Esa app desktop se compila/instala normalmente en el
equipo cliente; cuando ambas variables existen, no inicia runner, base de datos
ni PTYs locales:

```sh
# Tailscale
AGENT_COORDINATOR_REMOTE_URL="wss://nombre-maquina.tu-tailnet.ts.net/rpc" \
AGENT_COORDINATOR_REMOTE_TOKEN="tu-token" \
"/Applications/Agent Coordinator.app/Contents/MacOS/Agent Coordinator"

# Cloudflare Tunnel
AGENT_COORDINATOR_REMOTE_URL="wss://coordinator.tudominio.com/rpc" \
AGENT_COORDINATOR_REMOTE_TOKEN="tu-token" \
"/Applications/Agent Coordinator.app/Contents/MacOS/Agent Coordinator"
```

Desktop y navegador muestran la misma interfaz y pueden conectarse al mismo
runner a la vez. Si protegiste el hostname con Cloudflare Access, esta vía
desktop no pasará: Access espera la cookie del navegador (ver Paso 4B).

## Actualizaciones y límites actuales

- Actualizar el navegador o la app desktop no toca los agentes del runner.
- Cerrar o recargar un cliente vuelve a adjuntarse a las terminales persistidas;
  no vuelve a ejecutar worktree setup ni reenvía prompts.
- Actualizar o reiniciar el **runner** sí termina los procesos PTY —un proceso
  no puede sobrevivir a que su host se reinicie—, pero antes de eso el runner
  guarda la intención de cada tab. Al volver a arrancar, reconstruye setup si
  hacía falta, todos los agentes/shells abiertos y el estado de Auto Pilot. Un
  agente cuya conversación ya recibió un prompt se relanza en modo resume; un
  prompt que nunca llegó a enviarse se relanza limpio para no ejecutar un
  `codex resume` contra un id inexistente. Ningún navegador participa en esa
  recuperación.
- La web no sube archivos locales arrastrados al runner y no puede abrir el
  Finder del runner. Sube/copia esos archivos al host antes de enviarlos al
  agente.
