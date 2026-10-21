# Запуск Chog Toolhub на сервері (production)

Що вийде в кінці: сайт на твоєму домені з HTTPS через Cloudflare, справжня база PostgreSQL, щоденні
резервні копії бази, правильна IP-адреса кожного відвідувача (окремі ліміти для кожної людини).
Перевірено: 300 одночасних користувачів, 0 помилок, дані цілі після перезапуску (docs/PERFORMANCE.md).

```
відвідувач ──HTTPS──► Cloudflare ──тунель──► cloudflared ──► app (сайт + API) ──► PostgreSQL
                                                                     └──► щоденні копії бази
```

Порт застосунку назовні **не відкривається**: зайти можна тільки через Cloudflare. Тому заголовок
`cf-connecting-ip` (справжня IP відвідувача) неможливо підробити.

## 1. Що потрібно

- **Домен** (будь-який реєстратор або одразу Cloudflare Registrar — там без націнки).
- **Акаунт Cloudflare** (безкоштовного плану достатньо).
- **VPS-сервер** з Linux (Ubuntu 24.04): 2 vCPU, 4 ГБ RAM, 40 ГБ диска — з запасом для сотень
  користувачів (у тесті 300 людей сервер використав ~350 МБ пам'яті). Підійдуть Hetzner, DigitalOcean,
  Contabo тощо. Тримати сайт на домашньому ПК не варто: він має працювати 24/7.

## 2. Домен у Cloudflare

1. Cloudflare → **Add a domain** → введи домен → план **Free**.
2. Cloudflare покаже два nameserver-и — впиши їх у реєстратора домену (якщо купував у Cloudflare —
   нічого робити не треба). Дочекайся статусу **Active**.
3. **SSL/TLS → Overview → Full**. **SSL/TLS → Edge Certificates → Always Use HTTPS: On**.

## 3. Тунель Cloudflare

1. Cloudflare → **Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared**, назва: `chog`.
2. Скопіюй **token** (довгий рядок після `--token`) — це `CLOUDFLARE_TUNNEL_TOKEN`.
3. Вкладка **Public Hostname → Add**: Subdomain порожній, Domain — твій домен,
   Service: `HTTP` → `app:8787`. Збережи.

## 4. Сервер (Contabo / будь-який Ubuntu VPS) — три команди

Після оплати Contabo надсилає лист з **IP-адресою** і паролем **root**. IP і паролі нікому не пиши.

**Крок 1 — з твого ПК** (PowerShell у папці проєкту) скопіюй скрипт на сервер і зайди:

```powershell
scp deploy/setup-vps.sh root@IP_СЕРВЕРА:
ssh root@IP_СЕРВЕРА
```

**Крок 2 — на сервері (root):**

```bash
bash setup-vps.sh
```

Скрипт сам: оновить систему й увімкне автооновлення безпеки, створить користувача `chog` (попросить
придумати пароль), заборонить вхід root по SSH, закриє всі порти крім SSH (сайт іде через тунель — веб-порти
не потрібні), поставить fail2ban, файл підкачки, Docker, і створить **ключ для GitHub лише на читання**.
У кінці він покаже цей ключ — додай його: GitHub → `exsay07/chog-toolhub-hackathon` → Settings → **Deploy keys** →
Add deploy key, «Allow write access» **не ставити**.

**Крок 3 — перезайди як `chog`** (`ssh chog@IP_СЕРВЕРА`) і запусти:

```bash
git clone git@github.com:exsay07/chog-toolhub-hackathon.git
cd chog-toolhub && bash deploy/install.sh
```

`install.sh` попросить **токен тунелю** (ввід прихований) і домен (Enter = `chogtoolhub.space`), сам згенерує
пароль бази, збере й запустить усе та дочекається, поки сайт відповість. Відкрий `https://chogtoolhub.space`.

Перезапуск/логи вручну (з папки `deploy`):

```bash
docker compose ps              # app, db, backup, tunnel — "running"/"healthy"
docker compose logs -f app     # журнал сервера
```

## 5. Резервні копії

- Щодня о 00:00 сервіс `backup` робить стиснуту копію всієї бази в `deploy/backups/`
  (зберігаються 7 щоденних, 4 щотижневі, 6 щомісячних).
- **Копії поза сервером — Cloudflare R2** (10 ГБ безкоштовно). Якщо VPS зламається разом з диском, локальні
  копії зникнуть, а в R2 — залишаться. Налаштування один раз:
  1. Cloudflare → **R2 Object Storage** → увімкнути (Cloudflare може попросити картку, але безкоштовний ліміт
     10 ГБ / місяць нічого не коштує) → **Create bucket** → назва `chog-backups`.
  2. Бакет → **Settings → Object lifecycle rules** → додай правило «видаляти об'єкти старші за 180 днів».
  3. R2 → **Manage API tokens** → **Create API token** → дозвіл **Object Read & Write**, лише бакет
     `chog-backups` → Create. Скопіюй **Access Key ID** і **Secret Access Key**, а з головної сторінки R2 —
     **Account ID**.
  4. На сервері: `bash ~/chog-toolhub/deploy/offsite-setup.sh` — введи ці три значення (секрет прихований).
     Скрипт одразу вивантажить поточні копії і поставить щоденне вивантаження о 01:30. Вивантаження лише
     **додає** файли й ніколи не видаляє їх у R2.
- **Відновлення з копії** (перевірено наживо на PostgreSQL 17: копія → пошкодження → відновлення → дані
  ідентичні, сервер стартує):

  ```bash
  bash ~/chog-toolhub/deploy/restore.sh                                   # список копій
  bash ~/chog-toolhub/deploy/restore.sh ~/chog-toolhub/deploy/backups/daily/chog-YYYYMMDD.sql.gz
  ```

  Скрипт спершу робить страхувальну копію поточної бази (`backups/pre-restore-…`), зупиняє застосунок,
  створює базу заново і заливає копію **однією транзакцією** — або все, або нічого (якщо щось піде не так,
  повертає попередню базу). Просто «залити» дамп поверх живої бази не можна: впаде на «already exists».

## 6. Оновлення сайту

```bash
bash ~/chog-toolhub/deploy/update.sh
```

Спершу робить свіжу копію бази, потім `git pull`, перезбирає й перезапускає лише застосунок.

Нові таблиці/колонки (міграції) застосовуються самі при старті. Дані користувачів не чіпаються.

## 7. Ключі даних (необов'язково, але бажано)

Ключ вписується на сервері однією командою (значення вводиться приховано, сайт сам перезапуститься):

```bash
bash ~/chog-toolhub/deploy/set-key.sh OPENSEA_API_KEY
```

**Ключ OpenSea (постійний):** opensea.io → увійди гаманцем → іконка профілю → **Settings → Developer**
(<https://opensea.io/settings/developer>) → підтверди email («Verify in profile») → **Get access** → форма:
Organization name `Chog Toolhub`, Website `https://chogtoolhub.space`, Intended use «NFT collection stats
(floor, volume, owners) for holders' dashboard» → Submit → **Create API key** → скопіюй ключ і впиши командою
вище. Без ключа сервер сам бере безкоштовний ключ на 7 днів, але постійний — надійніший і з вищими лімітами.

| Змінна                     | Навіщо                               | Безкоштовно                                      |
| -------------------------- | ------------------------------------ | ------------------------------------------------ |
| `OPENSEA_API_KEY`          | Top Collections швидше               | порожньо = сервер сам бере free-ключ OpenSea     |
| `RPC_MONAD`, `RPC_BASE`, … | трекер гаманців, баланси, Mint Track | кілька URL через кому: офіційний RPC + free tier |
| `COINGECKO_PRO_API_KEY`    | графіки токенів без лімітів          | без нього — спільні 30 запитів/хв GeckoTerminal  |

**WalletConnect (вхід з телефона через QR):** <https://cloud.reown.com> → увійди (email / GitHub) → **Create
project** → тип **AppKit** (або «WalletKit/WalletConnect»), назва `Chog Toolhub` → скопіюй **Project ID** (32
символи). У налаштуваннях проєкту → **Domain / Allowlist** додай `chogtoolhub.space` і `www.chogtoolhub.space`.
Потім на сервері: `bash ~/chog-toolhub/deploy/set-key.sh WALLETCONNECT_PROJECT_ID`. Без нього кнопка «Phone
wallet» просто не показується — браузерні гаманці працюють і так.

## 8. Адреса www

Щоб `www.твій-домен` теж відкривав сайт: Cloudflare → **Networking → Tunnels** → твій тунель → **Routes** →
**Add route → Published application**: Subdomain `www`, Domain — твій домен, Service URL `http://app:8787`.
Сервер сам переадресує `www` на основну адресу (301), тож сесії й захист працюють на одному домені.

## 9. Перевірка після запуску

- `https://твій-домен/readyz` → `{"ok":true,"db":true}`.
- Увійти з гаманцем, що має Chog Genesis; змінити налаштування; перезайти з іншого браузера — вони
  на місці.
- `docker compose logs -f app` — журнал сервера.
