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

No hay diferencia funcional: el código, las sesiones y la URL de Tailscale son
los mismos. Linux es una recomendación operativa para un servidor dedicado, no
un requisito. Para la primera prueba, usa tu Mac más potente.

## Qué queda en cada máquina

```text
Mac/servidor que ejecuta el runner
  ├─ repositorios y worktrees
  ├─ agentes y sus OAuth (Codex, Claude, etc.)
  ├─ estado de Coordinator y scrollback
  └─ Tailscale Serve → URL privada HTTPS

Tu laptop/iPad/navegador
  └─ sólo la interfaz; no conserva agentes ni repositorios
```

Tailscale es el proxy privado entre ambas partes. El runner escucha únicamente
en `127.0.0.1:4765`: no se abre ningún puerto del router ni de Internet.

## Antes de empezar

En la máquina que será runner necesitas:

- este repositorio en la rama `feature/remote-coordinator`;
- Node, pnpm, Git y Tailscale;
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

## Paso 3: primera prueba, sin Tailscale todavía

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

Para probar continuidad, inicia un terminal/agente, cierra sólo la pestaña del
navegador y vuelve a abrir la URL. No cierres la terminal donde corre el
runner: detener el runner todavía detiene sus PTYs.

## Paso 4: darle una URL privada con Tailscale

Con el runner funcionando, en esa misma máquina ejecuta una vez:

```sh
tailscale serve --https=443 http://127.0.0.1:4765
```

Tailscale mostrará la URL `https://nombre-maquina.tu-tailnet.ts.net`. Ábrela
desde cualquier dispositivo que esté conectado a tu Tailnet. La interfaz usa
esa misma URL para el WebSocket seguro; sólo debes introducir el token de
Coordinator. No uses `tailscale funnel`.

Para revisar la configuración:

```sh
tailscale serve status
```

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
2. Edita `WorkingDirectory`, `EnvironmentFile` y, si aplica, la ruta de
   `pnpm`.
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
AGENT_COORDINATOR_REMOTE_URL="wss://nombre-maquina.tu-tailnet.ts.net/rpc" \
AGENT_COORDINATOR_REMOTE_TOKEN="tu-token" \
"/Applications/Agent Coordinator.app/Contents/MacOS/Agent Coordinator"
```

Desktop y navegador muestran la misma interfaz y pueden conectarse al mismo
runner a la vez.

## Actualizaciones y límites actuales

- Actualizar el navegador o la app desktop no toca los agentes del runner.
- Cerrar o recargar un cliente vuelve a adjuntarse a las terminales persistidas.
- Actualizar o reiniciar el **runner** sí termina sus PTYs por ahora. Hazlo sólo
  cuando no haya agentes importantes trabajando. Un broker de PTYs persistente
  será la siguiente mejora para actualizaciones sin interrupción.
- La web no sube archivos locales arrastrados al runner y no puede abrir el
  Finder del runner. Sube/copia esos archivos al host antes de enviarlos al
  agente.
