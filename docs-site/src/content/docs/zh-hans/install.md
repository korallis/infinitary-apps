---
source: 2633a75241365106
title: 安装
description: 下载适用于 Mac、Linux 或 Windows 的 Infinitary 稳定版，或申请 iPhone 和 iPad 版的 TestFlight 私密邀请。
---

下载适用于 [Mac](https://getinfinitary.com/downloads/#macos)、[Linux](https://getinfinitary.com/downloads/#linux) 或 [Windows](https://getinfinitary.com/downloads/#windows) 的 Infinitary 稳定版。
如果你想验证下载的文件，请把它的 SHA-256 校验和与下载页面上该文件旁显示的校验和进行比对。

## 在 Mac 上 {#on-a-mac}

为 Apple 芯片或 Intel 芯片的 Mac 下载 **Disk image (.dmg)**。
打开它，把 Infinitary 拖到“**应用程序**”。
如果你选择的是 **ZIP**，请打开它，并把解压出来的 Infinitary 应用移到“**应用程序**”。

## 在 Linux 上 {#on-linux}

Ubuntu 或 Debian 请选择 **.deb** 安装包，Fedora 请选择 **.rpm** 安装包，然后用系统的软件安装器打开它。
Arch 或 Omarchy 请使用 Arch 软件包配方；NixOS 请使用 Nix 配方。
在其他 x64 Linux 系统上，请下载 **AppImage**，在它的文件属性中允许它作为程序运行，然后打开它。

## 在 Windows 上 {#on-windows}

Windows 版 Infinitary 是实验版。
下载适用于搭载 Intel 或 AMD 64 位处理器的 Windows 11 电脑的 **安装程序 (.exe)**。
这个安装程序还没有用 Microsoft 验证的证书签名，所以 Windows 不认识它的发布者，会在安装前警告两次：

1. 如果浏览器说这个文件不常被下载，选择 **保留**，然后选择 **仍然保留**。
2. 打开它时，Windows 会显示“Windows 已保护你的电脑”，发布者未知。
   选择 **更多信息**，然后选择 **仍要运行**。

如果智能应用控制已打开，Windows 会阻止这个版本，并且不提供运行它的方法。
请保持智能应用控制打开，等待签名版本。

安装程序只为你一人安装 Infinitary，把它加到开始菜单并打开它。
如果你的电脑没有 Git for Windows，Infinitary 会在首次启动时提议安装它，因为你的船员需要它。

## 在 iPhone 和 iPad 上 {#on-iphone-and-ipad}

iPhone 和 iPad 版 Infinitary 正处于 TestFlight 私密测试阶段。
[发送邮件至 help@getinfinitary.com 申请邀请](mailto:help@getinfinitary.com?subject=Infinitary%20TestFlight%20request)。
如何连接你的电脑，请参阅 [iPhone 和 iPad](/zh-hans/iphone-and-ipad/)。

## 你需要什么 {#what-you-need}

- **一台电脑。**
  一台运行 macOS 12 或更高版本的 Mac、一台使用 x64 处理器的 Linux 电脑，或一台使用 x64 处理器的 Windows 11 电脑（实验版）。
- **一个 AI 订阅。**
  你的大副至少需要一个能够作答的订阅：Codex、Grok、Claude、Kimi Code、Copilot、使用 API 密钥的 OpenRouter，或使用你的 AWS 登录的 Amazon Bedrock。
- **使用 Claude 需要 Claude Code。**
  如果你使用 Claude 订阅，请先在那台电脑上安装 Claude Code。
  Infinitary 会使用你安装的 Claude Code。

## 首次启动 {#your-first-launch}

1. 打开 Infinitary。
   窗口会欢迎你，并为每个服务商显示一个按钮。
2. 选择你的服务商，并按它要求的方式登录：在浏览器中登录、使用代码登录，或粘贴密钥登录。
3. 当某个订阅能够作答时，消息框就会打开，你的大副也就准备好了。

请把大副设置在一台尽量保持开机的电脑上。
你的其他设备需要大副处于唤醒状态。

以后要更新或移除 Infinitary，请参阅[更新和移除 Infinitary](/zh-hans/update-and-remove/)。
如果遇到问题，请参阅[获取帮助](/zh-hans/get-help/)。
