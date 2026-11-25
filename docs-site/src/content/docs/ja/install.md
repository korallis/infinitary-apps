---
source: 2633a75241365106
title: インストール
description: Mac、Linux、Windows 用の安定版 Infinitary をダウンロードするか、iPhone と iPad 用の非公開 TestFlight への招待をリクエストします。
---

[Mac](https://getinfinitary.com/downloads/#macos)、[Linux](https://getinfinitary.com/downloads/#linux)、[Windows](https://getinfinitary.com/downloads/#windows) 用の Infinitary 安定版をダウンロードしてください。
ダウンロードしたファイルを検証したい場合は、その SHA-256 チェックサムを、ダウンロードページでそのファイルの横に表示されているものと比べてください。

## Mac の場合 {#on-a-mac}

Apple シリコン搭載の Mac 用、または Intel 搭載の Mac 用の **ディスクイメージ（.dmg）** をダウンロードします。
それを開き、Infinitary を **アプリケーション** にドラッグします。
代わりに **ZIP** を選んだ場合は、それを開き、展開された Infinitary アプリを **アプリケーション** に移動します。

## Linux の場合 {#on-linux}

Ubuntu または Debian では **.deb** パッケージを、Fedora では **.rpm** パッケージを選び、システムのソフトウェアインストーラーで開きます。
Arch または Omarchy では Arch パッケージのレシピを、NixOS では Nix のレシピを使います。
そのほかの x64 Linux システムでは、**AppImage** をダウンロードし、ファイルのプロパティでプログラムとしての実行を許可してから開きます。

## Windows の場合 {#on-windows}

Windows 版の Infinitary は試験版です。
Intel または AMD の 64 ビットプロセッサーを搭載した Windows 11 PC 用の **インストーラー (.exe)** をダウンロードしてください。
このインストーラーはまだ Microsoft が検証する証明書で署名されていないため、Windows は発行元を認識できず、インストール前に 2 回警告します。

1. ブラウザーがこのファイルは一般的にダウンロードされていないと表示したら、**保存** を選び、続けて **保持する** を選びます。
2. 開くと、Windows が発行元不明として「Windows によって PC が保護されました」と表示します。
   **詳細情報** を選び、続けて **実行** を選びます。

スマート アプリ コントロールがオンの場合、Windows はこのビルドをブロックし、実行する方法を示しません。
スマート アプリ コントロールはオンのままにして、署名済みのビルドをお待ちください。

インストーラーは Infinitary をあなただけのためにインストールし、スタートメニューに追加して開きます。
PC に Git for Windows がない場合、乗組員に必要なため、Infinitary が初回起動時にインストールを提案します。

## iPhone と iPad の場合 {#on-iphone-and-ipad}

iPhone と iPad 用の Infinitary は、非公開の TestFlight で提供しています。
[招待をリクエストするには help@getinfinitary.com にメールしてください](mailto:help@getinfinitary.com?subject=Infinitary%20TestFlight%20request)。
コンピューターに接続する方法は、[iPhone と iPad](/ja/iphone-and-ipad/) を参照してください。

## 必要なもの {#what-you-need}

- **コンピューター。**
  macOS 12 以降の Mac、x64 プロセッサーを搭載した Linux コンピューター、または x64 プロセッサーを搭載した Windows 11 PC（試験版）。
- **AI のサブスクリプション。**
  一等航海士には、応答できるサブスクリプションが少なくとも 1 つ必要です：Codex、Grok、Claude、Kimi Code、Copilot、API キーを使う OpenRouter、または AWS へのサインインを使う Amazon Bedrock。
- **Claude を使う場合は Claude Code。**
  Claude のサブスクリプションを使う場合は、先にそのコンピューターに Claude Code をインストールしてください。
  Infinitary は、インストールした Claude Code を使います。

## 最初の起動 {#your-first-launch}

1. Infinitary を開きます。
   ウインドウに歓迎のメッセージと、プロバイダーごとのボタンが表示されます。
2. プロバイダーを選び、求められる方法でサインインします：ブラウザで行う、コードを入力する、またはキーを貼り付ける、のいずれかです。
3. サブスクリプションが応答できるようになると、メッセージ欄が開き、一等航海士の準備が整います。

一等航海士は、できるだけ電源が入ったままのコンピューターにセットアップしてください。
ほかのデバイスを使うには、一等航海士が起動している必要があります。

あとで Infinitary をアップデートまたは削除するには、[Infinitary のアップデートと削除](/ja/update-and-remove/)を参照してください。
うまくいかないことがあれば、[ヘルプ](/ja/get-help/)を参照してください。
