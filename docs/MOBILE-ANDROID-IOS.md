# Commercial Insight Mobile — Android e iOS (Capacitor 8)

Aplicativos nativos Android e iOS para o **Comercial Insight** (`br.com.araujoempresarial.commercialinsight`), construídos sobre a mesma base web e conectados ao mesmo backend Cloudflare Workers e banco D1 existentes.

## 1. Arquitetura e Integração

- **Identificador do aplicativo:** `br.com.araujoempresarial.commercialinsight`
- **Nome exibido:** `Comercial Insight`
- **Backend compartilhado:** Cloudflare Workers + D1 + R2 já existentes (`https://commercial-insight.araujoempresarial.com.br` em produção e `https://commercial-insight-hml.araujo-anderson26.workers.dev` em homologação).
- **Sem banco comercial local:** o aplicativo consulta os dados diretamente via HTTPS no backend autorizado. Quando fica sem conexão, exibe tela clara de estado offline e limpa o cache em memória para não apresentar valores financeiros antigos como se fossem atuais.
- **IA e orçamento preservados:** consultas determinísticas no D1 e o teto operacional de US\$ 20/mês da OpenAI permanecem controlados exclusivamente no servidor. Nenhuma chave OpenAI, token Cloudflare ou segredo é embutido no aplicativo.

## 2. Segurança Mobile

- **Armazenamento seguro de sessão:**
  - **Android:** `SecureSessionPlugin.java` criptografa o token em AES-256-GCM usando chave gerenciada no `AndroidKeyStore`, gravando apenas o texto cifrado em `SharedPreferences` (`MODE_PRIVATE`, arquivo `ci_secure_session.xml` excluído de backups em `backup_rules.xml` e `data_extraction_rules.xml`).
  - **iOS:** `SecureSessionPlugin.swift` armazena o token no Keychain nativo com `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` (sem sincronização em nuvem).
  - **Camada WebView (`src/lib/runtime.ts`):** mantém o token apenas em memória RAM (`Bearer`) após hidratação inicial, evitando `localStorage` persistente.
- **Transporte HTTPS obrigatório:** `resolveApiUrl` exige `https://`; `network_security_config.xml` (Android) e `NSAppTransportSecurity` (iOS) bloqueiam tráfego em texto claro (`cleartext`).
- **Controle de origem e sessão:**
  - Somente origens explícitas em `MOBILE_ORIGINS` (`capacitor://localhost,https://localhost`) recebem cabeçalhos CORS e emissão de token Bearer para o app.
  - `POST /api/auth/refresh` rotaciona o token antes da expiração e invalida imediatamente o token anterior no D1.
  - `POST /api/auth/logout`, alteração de senha e revogação de usuário no servidor encerram a sessão e limpam o armazenamento seguro e arquivos temporários exportados.

> **Importante (pré-requisito antes de distribuir para produção):** após a aprovação desta PR e antes do uso do app em dispositivos finais contra produção, é necessário publicar o Worker de produção com `MOBILE_ORIGINS="capacitor://localhost,https://localhost"` (já declarado em `wrangler.jsonc`).

## 3. Separação de Ambientes (Homologação vs Produção)

- **Bundle mobile de produção (`VITE_APP_ENV=production`):**
  ```powershell
  npm run build:mobile
  npx cap sync
  ```
- **Bundle mobile de homologação (`VITE_APP_ENV=homologation`):**
  ```powershell
  npm run build:mobile:hml
  npx cap sync
  ```

Os templates de referência sem segredos ficam em `.env.mobile.example` e `.env.mobile.hml.example`.

## 4. Instalação no Android (APK de Testes)

O APK de testes (assinatura de debug para distribuição controlada) foi compilado localmente fora do versionamento Git em:

- `outputs/mobile/comercial-insight-2.0.0-debug.apk` (`6.084.723` bytes · `versionCode 1` · `versionName 2.0.0` · `minSdk 24` · `targetSdk 36`).

### Opção A — Instalação direta no aparelho Android
1. Copie `comercial-insight-2.0.0-debug.apk` para o aparelho Android (cabo USB, Drive corporativo ou rede local segura).
2. Abra o arquivo pelo gerenciador de arquivos do Android.
3. Caso solicitado pela primeira instalação fora da loja, autorize temporariamente **Instalar apps desconhecidos** para o gerenciador de arquivos e conclua a instalação.

### Opção B — Instalação via USB com ADB
1. Ative **Opções do desenvolvedor -> Depuração USB** no aparelho Android e conecte ao PC.
2. Execute:
   ```powershell
   adb devices
   adb install -r outputs/mobile/comercial-insight-2.0.0-debug.apk
   ```

## 5. Assinatura e Publicação na Google Play Store (AAB)

Um AAB **não assinado** foi compilado para validar o empacotamento release (`outputs/mobile/comercial-insight-2.0.0-release-unsigned.aab`, `4.026.573` bytes). **Não envie este arquivo não assinado à loja.**

### Gerar a chave privada de assinatura (uma única vez, fora do repositório)
```powershell
New-Item -ItemType Directory -Force "$HOME\.android\keystores" | Out-Null
keytool -genkeypair -v -keystore "$HOME\.android\keystores\commercial-insight-release.jks" `
  -alias commercial-insight-upload -keyalg RSA -keysize 4096 -validity 10000
```
Guarde o arquivo `.jks` e as senhas em cofre seguro (nunca no repositório Git).

### Compilar o AAB assinado
```powershell
$env:ANDROID_KEYSTORE_PATH = "$HOME\.android\keystores\commercial-insight-release.jks"
$env:ANDROID_KEY_ALIAS = "commercial-insight-upload"
$env:ANDROID_KEYSTORE_PASSWORD = "<SENHA_DA_KEYSTORE>"
$env:ANDROID_KEY_PASSWORD = "<SENHA_DA_CHAVE>"
npm run build:mobile
npx cap sync android
node scripts/build-android.mjs --task=bundleRelease
```
Saída esperada: `outputs/mobile/comercial-insight-2.0.0-release-signed.aab`.

### Publicação no Google Play Console
1. Crie uma conta de desenvolvedor no **Google Play Console** e configure **Play App Signing**.
2. Cadastre o app (`br.com.araujoempresarial.commercialinsight`), ficha da loja, ícones/capturas, política de privacidade e **Data Safety** (declarando ausência de venda de dados e coleta estrita para autenticação e operação comercial).
3. Inicie uma faixa de **Teste interno** enviando `comercial-insight-2.0.0-release-signed.aab`, valide em aparelhos reais e promova para **Produção**.

## 6. Compilação e Publicação no iPhone / iOS (macOS + Xcode)

O projeto iOS em `ios/App` já está configurado com Capacitor 8 (Swift Package Manager `CapApp-SPM`), ícones e splash `Assets.xcassets`, `PrivacyInfo.xcprivacy`, `SecureSessionPlugin.swift`, `NativePrintPlugin.swift`, `AppBridgeViewController.swift`, `SceneDelegate.swift` e `Info.plist` (`ITSAppUsesNonExemptEncryption = false`, ATS estrito).

**Por limitação do ambiente Windows atual (sem macOS/Xcode), nenhum `.ipa` foi compilado ou assinado nesta etapa.**

### Requisitos em macOS para compilar e instalar no iPhone
- Mac com macOS atualizado e **Xcode** (versão recente compatível com iOS SDK 18+ e Swift 5).
- Conta ativa no **Apple Developer Program** (US\$ 99/ano) ou Apple ID pessoal (apenas teste local por 7 dias em cabo USB).
- Node.js 22+ / 24+.

### Passo a passo no Mac
```bash
git clone https://github.com/araujoanderson26-eng/commercial-insight.git
cd commercial-insight
git checkout feat/mobile-android-ios
npm ci
npm run mobile:sync
npx cap open ios
```
No Xcode:
1. Selecione o projeto **App -> Signing & Capabilities**, marque **Automatically manage signing**, escolha o seu **Team** e confirme o Bundle Identifier `br.com.araujoempresarial.commercialinsight`.
2. Para testar via USB em um iPhone conectado: selecione o iPhone como destino e pressione **Run (Cmd + R)**.
3. Para **TestFlight e App Store Connect**: selecione **Any iOS Device (arm64)** -> menu **Product -> Archive** -> **Distribute App -> App Store Connect -> Upload**.
4. No **App Store Connect**, preencha Questionário de Privacidade (alinhado ao `PrivacyInfo.xcprivacy`), libere no **TestFlight** para testes e submeta à revisão da App Store.
