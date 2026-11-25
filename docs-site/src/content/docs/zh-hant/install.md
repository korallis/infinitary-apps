---
source: 2633a75241365106
title: 安裝
description: 下載 Mac、Linux 或 Windows 版的 Infinitary 穩定版，或索取 iPhone 和 iPad 的 TestFlight 私人邀請。
---

下載 [Mac](https://getinfinitary.com/downloads/#macos)、[Linux](https://getinfinitary.com/downloads/#linux) 或 [Windows](https://getinfinitary.com/downloads/#windows) 版的 Infinitary 穩定版。
如果你想驗證下載的檔案，請把它的 SHA-256 校驗碼和下載頁面上該檔案旁顯示的校驗碼比對。

## 在 Mac 上 {#on-a-mac}

依你的 Mac 是 Apple 晶片或 Intel，下載對應的 **Disk image (.dmg)**。
打開它，把 Infinitary 拖到「**應用程式**」。
如果你改選 **ZIP**，請打開它，再把解壓縮出來的 Infinitary 程式移到「**應用程式**」。

## 在 Linux 上 {#on-linux}

Ubuntu 或 Debian 請選擇 **.deb** 套件，Fedora 請選擇 **.rpm** 套件，再用系統的軟體安裝程式打開。
Arch 或 Omarchy 請使用 Arch 套件配方；NixOS 請使用 Nix 配方。
在其他 x64 Linux 系統上，請下載 **AppImage**，在它的檔案內容中允許它以程式執行，然後打開它。

## 在 Windows 上 {#on-windows}

Windows 版 Infinitary 是實驗版。
下載適用於搭載 Intel 或 AMD 64 位元處理器之 Windows 11 電腦的 **安裝程式 (.exe)**。
這個安裝程式還沒有用 Microsoft 驗證的憑證簽署，所以 Windows 不認得它的發行者，會在安裝前警告兩次：

1. 如果瀏覽器說這個檔案不常被下載，選擇 **保留**，再選擇 **仍要保留**。
2. 打開它時，Windows 會顯示「Windows 已保護您的電腦」，發行者不明。
   選擇 **其他資訊**，再選擇 **仍要執行**。

如果智慧型應用程式控制已開啟，Windows 會封鎖這個版本，也不提供執行它的方法。
請讓智慧型應用程式控制保持開啟，等待簽署過的版本。

安裝程式只為你一個人安裝 Infinitary，把它加到開始功能表並打開它。
如果你的電腦沒有 Git for Windows，Infinitary 會在第一次啟動時提議安裝它，因為你的船員需要它。

## 在 iPhone 和 iPad 上 {#on-iphone-and-ipad}

iPhone 和 iPad 版的 Infinitary 目前以私人 TestFlight 提供。
[寄信到 help@getinfinitary.com 索取邀請](mailto:help@getinfinitary.com?subject=Infinitary%20TestFlight%20request)。
如何加入你的電腦，請參閱 [iPhone 和 iPad](/zh-hant/iphone-and-ipad/)。

## 你需要什麼 {#what-you-need}

- **一台電腦。**
  搭載 macOS 12 或更新版本的 Mac、搭載 x64 處理器的 Linux 電腦，或搭載 x64 處理器的 Windows 11 電腦（實驗版）。
- **一個 AI 訂閱方案。**
  你的大副至少需要一個能回應的訂閱方案：Codex、Grok、Claude、Kimi Code、Copilot、搭配 API 金鑰的 OpenRouter，或搭配你 AWS 登入的 Amazon Bedrock。
- **使用 Claude 需要 Claude Code。**
  如果你使用 Claude 訂閱方案，請先在那台電腦上安裝 Claude Code。
  Infinitary 會使用你安裝的 Claude Code。

## 第一次啟動 {#your-first-launch}

1. 打開 Infinitary。
   視窗會歡迎你，並為每個供應商顯示一個按鈕。
2. 選擇你的供應商，依它要求的方式登入：在瀏覽器中登入、輸入代碼，或貼上金鑰。
3. 有訂閱方案能回應時，訊息框就會打開，你的大副也準備好了。

請把大副設定在一台盡量保持開機的電腦上。
你的其他裝置需要大副醒著才能使用。

日後要更新或移除 Infinitary，請參閱[更新與移除 Infinitary](/zh-hant/update-and-remove/)。
如果有東西無法運作，請參閱[取得協助](/zh-hant/get-help/)。
