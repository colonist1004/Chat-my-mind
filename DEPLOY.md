# 무료 서버에 배포하기 (Oracle Cloud Always Free)

Oracle Cloud 의 **Always Free** 서버는 기간 제한 없이 계속 무료입니다.
ARM 서버를 최대 4코어·24GB 메모리까지 무료로 쓸 수 있고, 이 앱에는 1코어·6GB 면 충분합니다.

> AWS 도 같은 방법(Docker)으로 배포할 수 있지만, AWS 무료 혜택은 신규 계정의 기간·크레딧 한정이라
> 기간이 끝나면 요금이 나옵니다. 계속 무료로 쓰려면 Oracle 을 추천합니다.

전체 흐름: **서버 만들기 → 포트 열기 → Docker 설치 → 코드 받기 → `.env` 작성 → 실행**

---

## 1. Oracle Cloud 가입

1. <https://www.oracle.com/cloud/free/> 에서 가입합니다.
   - 본인 확인용으로 카드 등록이 필요하지만, Always Free 자원만 쓰면 요금이 나가지 않습니다.
   - **홈 리전**은 나중에 바꿀 수 없습니다. 한국에서 쓴다면 `South Korea Central (Seoul)` 또는
     `South Korea North (Chuncheon)` 을 고르세요.

## 2. 서버(인스턴스) 만들기

콘솔 메뉴 → **Compute → Instances → Create instance**

| 항목 | 선택 |
|---|---|
| Image | **Canonical Ubuntu 24.04** |
| Shape | **Ampere → VM.Standard.A1.Flex**, OCPU 1~2, Memory 6~12 GB (Always Free 표시 확인) |
| Networking | 기본 VCN, **Assign a public IPv4 address** 체크 |
| SSH keys | **Save private key** 로 키 파일을 내려받아 보관 |

만든 뒤 인스턴스 화면에서 **Public IP address** 를 메모하세요. (예: `152.67.10.20`)

> "Out of capacity" 오류가 나면 무료 ARM 서버가 잠시 부족한 것입니다. 다른 Availability Domain 을
> 고르거나 시간을 두고 다시 시도하세요. 대신 `VM.Standard.E2.1.Micro`(AMD, 1GB, 역시 무료)를 써도 됩니다.
> 이 경우 아래 4번 뒤에 스왑을 꼭 추가하세요:
> `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab`

## 3. 웹 포트(80, 443) 열기

Oracle 은 두 곳에서 막혀 있으므로 **둘 다** 열어야 합니다.

**(1) 클라우드 방화벽**: 인스턴스 화면 → Subnet 링크 → **Security Lists → Default Security List → Add Ingress Rules**

| Source CIDR | IP Protocol | Destination Port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

**(2) 서버 내부 방화벽**: SSH 로 접속해서 실행합니다.

```bash
# 내 PC 에서 (키 파일 경로와 IP 는 본인 것으로)
chmod 600 ~/Downloads/ssh-key.key
ssh -i ~/Downloads/ssh-key.key ubuntu@152.67.10.20
```

```bash
# 서버에서
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

## 4. Docker 설치

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
exit   # 한 번 나갔다가 다시 ssh 로 접속해야 적용됩니다
```

## 5. 코드 받기

```bash
git clone https://github.com/colonist1004/Chat-my-mind.git
cd Chat-my-mind
```

> 저장소가 비공개라면 GitHub 의 **Settings → Developer settings → Personal access tokens** 에서
> 읽기 권한 토큰을 만들고, clone 할 때 비밀번호 대신 토큰을 입력하세요.

## 6. 설정 파일(.env) 작성

```bash
cp .env.example .env
nano .env
```

꼭 채워야 하는 값:

| 키 | 값 |
|---|---|
| `ANTHROPIC_API_KEY` | <https://platform.claude.com/settings/keys> 에서 만든 Claude API 키 |
| `DOMAIN` | 도메인이 없으면 공인 IP 의 `.` 을 `-` 로 바꾸고 `.sslip.io` 를 붙입니다. 예) `152-67-10-20.sslip.io` |
| `INVITE_CODE` | 가입할 때 쓸 초대 코드. **꼭 정하세요.** 비워 두면 모르는 사람도 가입해 API 비용을 쓸 수 있습니다. |

저장: `Ctrl+O` → Enter → `Ctrl+X`

## 7. 실행

```bash
docker compose up -d --build
```

1~3분 뒤 브라우저에서 `https://152-67-10-20.sslip.io` (내 DOMAIN) 로 접속합니다.
HTTPS 인증서는 자동으로 발급·갱신됩니다.

- **처음 가입한 계정이 관리자**가 됩니다(하루 사용 횟수 무제한). 배포 직후 바로 본인 계정부터 만드세요.
- 휴대폰에서는 브라우저 메뉴의 **홈 화면에 추가** 로 앱처럼 쓸 수 있습니다.

---

## 운영

| 하고 싶은 일 | 명령 (서버의 `Chat-my-mind` 폴더에서) |
|---|---|
| 로그 보기 | `docker compose logs -f app` |
| 코드 업데이트 | `git pull && docker compose up -d --build` |
| 설정(.env) 바꾼 뒤 적용 | `docker compose up -d` |
| 재시작 / 중지 | `docker compose restart` / `docker compose down` |
| DB 백업 | `docker compose exec app node server/backup.js` 후 `docker compose cp app:/data/. ./backups/` |

데이터(계정, 캐릭터, 대화)는 Docker 볼륨 `appdata` 에 저장되어 업데이트·재시작해도 유지됩니다.
가끔 백업 파일을 내 PC 로 옮겨 두세요:
`scp -i ~/Downloads/ssh-key.key -r ubuntu@152.67.10.20:~/Chat-my-mind/backups ./`

## Claude API 비용 관리

서버는 무료지만 **Claude API 는 사용한 만큼 요금이 나옵니다.**

- Claude Console 의 **Billing → Spend limits** 에서 월 사용 한도를 꼭 걸어 두세요.
- `.env` 의 `DAILY_MESSAGE_LIMIT` 로 사용자당 하루 답변 수를 제한할 수 있습니다.
- 비용을 줄이려면 `DEFAULT_MODEL=claude-sonnet-5-5` 나 `claude-haiku-5-5` 로 바꾸고,
  `ALLOWED_MODELS` 에서 비싼 모델을 빼세요. 대화 이력은 자동으로 프롬프트 캐시되어 긴 대화일수록 비용이 줄어듭니다.
