# بوت مسابقة الصور

1. حط توكن البوت في ملف `.env` بعد `TOKEN=`
2. من Discord Developer Portal > Bot فعّل **Server Members Intent** و **Message Content Intent**
3. `npm install` ثم `npm start` (Node 18 أو أحدث)
4. في السيرفر اكتب: `!setup #روم-الصور #روم-التصويت`

صلاحيات البوت: View Channel, Send Messages, Manage Messages, Attach Files, Add Reactions, Read Message History

الأوامر (لمن عنده Manage Server): `!help`

## الأصوات الصالحة
- رياكشن البوت وأي بوت ما ينحسب
- اللي طلع من السيرفر ما يحسب صوته
- الحساب الأحدث من عدد أيام معيّن (الافتراضي 7) ما يحسب صوته (`!minage`)
- صاحب الصورة ما يصوّت لنفسه (`!selfvote`)
- عدد الأصوات الصالحة يتحدث تحت كل مشاركة تلقائياً
