# Cloudflare Quick Tunnel 설정 프롬프트

아래 프롬프트를 다른 프로젝트의 AI 에이전트에 붙여넣으면 동일한 설정을 자동으로 진행합니다.

---

## 프롬프트

```
이 프로젝트를 Cloudflare Quick Tunnel로 외부 접속 가능하게 설정해줘.

조건:
1. cloudflared가 설치 안 되어있으면 winget으로 설치
   - winget install --id Cloudflare.cloudflared
   - 설치 경로: %LOCALAPPDATA%\Microsoft\WinGet\Packages\Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe\cloudflared.exe

2. npm run build로 프로덕션 빌드 (빌드 오류 있으면 먼저 수정)

3. 시작 명령어를 PowerShell용으로 정리해서 줘:
   - npm start로 프로덕션 서버 실행 (기본 포트 3000)
   - cloudflared tunnel --url http://localhost:3000 으로 Quick Tunnel 실행
   - PowerShell 한 줄 명령어로 둘 다 실행되게

4. Quick Tunnel은 도메인 불필요, Cloudflare 계정 불필요
   - 재시작할 때마다 URL이 바뀜
   - 터미널에 https://xxx.trycloudflare.com URL이 출력됨
   - 그 URL로 외부에서 접속 가능

5. 보안 주의사항:
   - Quick Tunnel URL을 불특정 다수에게 공유 금지
   - 앱에 인증이 없으면 URL 아는 사람 누구나 접근 가능
   - API 키가 localStorage에 있으면 XSS 위험

6. 상시 운영하려면:
   - 별도 터미널/PowerShell에서 직접 실행 (백그라운드 프로세스는 자동 종료됨)
   - 또는 Windows 서비스로 등록

PowerShell 시작 명령어 형식:
cd <프로젝트경로>; Start-Process cmd -ArgumentList "/c npm start" -WindowStyle Minimized; Start-Sleep 8; & "<cloudflared.exe 경로>" tunnel --url http://localhost:<포트>
```

---

## 실제 사용 예시 (이 프로젝트)

```powershell
cd d:\Dithub\funding-fee-program; Start-Process cmd -ArgumentList "/c npm start" -WindowStyle Minimized; Start-Sleep 8; & "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe\cloudflared.exe" tunnel --url http://localhost:3000
```

## Named Tunnel (도메인 필요 시)

도메인이 있으면 Cloudflare 대시보드에서:
1. Zero Trust → Networks → Tunnels → Create tunnel
2. Public Hostname에 도메인 연결
3. cloudflared service install <토큰> 으로 Windows 서비스 등록
4. Access 정책으로 인증 추가
