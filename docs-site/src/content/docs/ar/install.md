---
source: 2633a75241365106
title: التثبيت
description: نزّل الإصدار المستقر من Infinitary لـ Mac أو Linux أو Windows، أو اطلب دعوة خاصة إلى TestFlight لـ iPhone وiPad.
---

نزّل الإصدار المستقر من Infinitary لـ [Mac](https://getinfinitary.com/downloads/#macos) أو [Linux](https://getinfinitary.com/downloads/#linux) أو [Windows](https://getinfinitary.com/downloads/#windows).
إذا أردت التحقق من ملف نزّلته، فقارن مجموعه الاختباري SHA-256 بالمجموع المعروض بجانب ذلك الملف في صفحة التنزيلات.

## على Mac {#on-a-mac}

نزّل **صورة القرص (.dmg)** لـ Mac بشريحة Apple أو بمعالج Intel.
افتحها واسحب Infinitary إلى **التطبيقات**.
إذا اخترت **ZIP** بدلًا من ذلك، فافتحه وانقل تطبيق Infinitary المستخرج إلى **التطبيقات**.

## على Linux {#on-linux}

اختر حزمة **.deb** لـ Ubuntu أو Debian، أو حزمة **.rpm** لـ Fedora، وافتحها بمثبّت البرامج في نظامك.
لـ Arch أو Omarchy، استخدم وصفة حزمة Arch؛ ولـ NixOS، استخدم وصفة Nix.
على أنظمة Linux الأخرى بمعالج x64، نزّل **AppImage**، واسمح بتشغيله كبرنامج من خصائص الملف، ثم افتحه.

## على Windows {#on-windows}

Infinitary لـ Windows إصدار تجريبي.
نزّل **المثبّت (.exe)** لحاسوب Windows 11 بمعالج Intel أو AMD بمعمارية 64 بت.
المثبّت غير موقّع بعد بشهادة تتحقق منها Microsoft، لذلك لا يعرف Windows ناشره ويحذّرك مرتين قبل التثبيت:

1. إذا قال متصفحك إن الملف لا يُنزَّل عادةً، فاختر **الاحتفاظ**، ثم **الاحتفاظ على أي حال**.
2. عند فتحه، يعرض Windows رسالة "حماية Windows لجهاز الكمبيوتر الخاص بك" مع ناشر غير معروف.
   اختر **مزيد من المعلومات**، ثم **تشغيل على أي حال**.

إذا كان التحكم الذكي في التطبيقات مشغّلًا، فإن Windows يحظر هذا الإصدار ولا يقدّم أي طريقة لتشغيله.
يُرجى إبقاء التحكم الذكي في التطبيقات مشغّلًا وانتظار الإصدار الموقّع.

يثبّت المثبّت Infinitary لك وحدك، ويضيفه إلى قائمة ابدأ ويفتحه.
إذا لم يكن على حاسوبك Git for Windows، يعرض Infinitary تثبيته عند أول تشغيل، لأن طاقمك يحتاج إليه.

## على iPhone وiPad {#on-iphone-and-ipad}

Infinitary لـ iPhone وiPad متاح في TestFlight الخاص.
[راسل help@getinfinitary.com لطلب دعوة](mailto:help@getinfinitary.com?subject=Infinitary%20TestFlight%20request).
انظر [iPhone وiPad](/ar/iphone-and-ipad/) لتعرف كيف تنضم إلى حاسوبك.

## ما تحتاج إليه {#what-you-need}

- **حاسوب.**
  Mac بنظام macOS 12 أو أحدث، أو حاسوب Linux بمعالج x64، أو حاسوب Windows 11 بمعالج x64 (تجريبي).
- **اشتراك في الذكاء الاصطناعي.**
  يحتاج نائب القبطان إلى اشتراك واحد على الأقل يمكنه الإجابة: Codex أو Grok أو Claude أو Kimi Code أو Copilot، أو OpenRouter بمفتاح API، أو Amazon Bedrock بتسجيل دخولك إلى AWS.
- **Claude Code، من أجل Claude.**
  إذا كنت تستخدم اشتراك Claude، فثبّت Claude Code على ذلك الحاسوب أولًا.
  يستخدم Infinitary نسخة Claude Code التي ثبّتها.

## تشغيلك الأول {#your-first-launch}

1. افتح Infinitary.
   ترحّب بك النافذة وتعرض زرًّا لكل مزوّد.
2. اختر مزوّدك وسجّل الدخول بالطريقة التي يطلبها: في متصفحك، أو برمز، أو بمفتاح تلصقه.
3. حين يستطيع اشتراك الإجابة، يُفتح مربع الرسالة ويصبح نائب القبطان جاهزًا.

أعدّ نائب القبطان على حاسوب يبقى قيد التشغيل قدر الإمكان.
أجهزتك الأخرى تحتاج إلى أن يكون نائب القبطان مستيقظًا.

لتحديث Infinitary أو إزالته لاحقًا، انظر [تحديث Infinitary وإزالته](/ar/update-and-remove/).
إذا لم يعمل شيء ما، فانظر [الحصول على المساعدة](/ar/get-help/).
