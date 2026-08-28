/**
 * ar.js — Arabic strings (CLAUDE.md 8.1).
 *
 * Every key in en.js exists here. When a key is added there it must be added
 * here in the same commit; a missing key falls back to English at runtime, but
 * that is a bug to fix, not a feature.
 */

export const ar = {

  /* --- chrome --- */
  app_name: 'مدقق التسويات',
  brand_name: 'التسويات',
  brand_tagline: 'المصروفات والوقود · العمليات',
  brand_mark: 'ت',

  nav_dashboard: 'الرئيسية',
  nav_approvals: 'الاعتمادات',
  nav_export: 'التصدير',
  nav_admin: 'الإدارة',
  nav_teams: 'الفرق',
  nav_sitejc: 'الموقع ← كود العمل',
  nav_people: 'المستخدمون',
  nav_lists: 'القوائم',

  sign_out: 'تسجيل الخروج',
  language: 'اللغة',
  lang_en: 'EN',
  lang_ar: 'ع',

  role_coordinator: 'منسق',
  role_manager: 'مدير',

  /* --- common --- */
  loading: 'جارٍ التحميل…',
  retry: 'إعادة المحاولة',
  cancel: 'إلغاء',
  save: 'حفظ',
  close: 'إغلاق',
  back: 'رجوع',

  /* --- first-run: the Apps Script URL (rule 2) --- */
  setup_title: 'ربط هذا الجهاز',
  setup_subtitle: 'الصق رابط تطبيق الويب الخاص بـ Apps Script. يُحفظ على هذا الجهاز فقط ولا يكون جزءاً من التطبيق.',
  setup_url_label: 'رابط تطبيق الويب (Apps Script)',
  setup_url_placeholder: 'https://script.google.com/macros/s/…/exec',
  setup_connect: 'اتصال',
  setup_connecting: 'جارٍ الاتصال…',
  setup_url_required: 'أدخل رابط تطبيق الويب.',
  setup_url_invalid: 'هذا الرابط لا يبدو رابط تطبيق ويب من Apps Script.',
  setup_change_url: 'تغيير رابط الخادم',

  /* --- boot failure --- */
  boot_failed_title: 'تعذّر الوصول إلى الخادم',
  boot_failed_subtitle: 'لم يتمكن التطبيق من تحميل إعداداته. تحقق من الاتصال ومن رابط تطبيق الويب ثم أعد المحاولة.',

  /* --- login --- */
  login_title: 'تسجيل الدخول',
  login_subtitle: 'استخدم حسابك في مدقق التسويات.',
  login_username: 'اسم المستخدم',
  login_username_placeholder: 'اسم.المستخدم',
  login_password: 'كلمة المرور',
  login_submit: 'تسجيل الدخول',
  login_working: 'جارٍ تسجيل الدخول…',
  login_username_required: 'أدخل اسم المستخدم.',
  login_password_required: 'أدخل كلمة المرور.',
  login_welcome_back: 'أهلاً بعودتك، {name}.',

  /* --- dashboards --- */
  dashboard_title: 'الرئيسية',
  signed_in_as: 'مسجّل الدخول باسم {name}',
  coordinator_dashboard_subtitle: 'تسوياتك، تسوية واحدة لكل شهر.',
  manager_dashboard_subtitle: 'جميع المنسقين في مكان واحد.',

  my_settlements: 'تسوياتي',
  settlement_title: 'التسوية',
  col_settlement: 'التسوية',
  col_month: 'الشهر',
  col_account: 'الحساب',
  col_old_track: 'رقم التتبع (قديم)',
  col_new_track: 'رقم التتبع (جديد)',
  no_settlements_title: 'لا توجد تسويات بعد',
  no_settlements_text: 'بعد تفعيل الإدخال ستنشئ هنا تسوية واحدة لكل شهر، لكل منها رقم تتبع قديم وآخر جديد.',

  quick_actions: 'إجراءات سريعة',
  action_approvals_text: 'مراجعة واعتماد الإدخالات المؤكدة من جميع المنسقين.',
  action_export_text: 'إنشاء ملفات الحسابات لفريق وفترة محددين.',
  action_admin_text: 'الفرق، وجدول الموقع ← كود العمل، والمستخدمون، والقوائم.',

  stat_pending_data: 'بانتظار البيانات',
  stat_open_settlements: 'تسويات مفتوحة',
  stat_draft_entries: 'إدخالات مسودة',
  stat_awaiting_approval: 'بانتظار الاعتماد',
  stat_returned_to_me: 'مُعادة إليّ',
  stat_approved_unexported: 'معتمدة وغير مصدّرة',
  stat_returned_open: 'مُعادة وقيد المعالجة',
  stat_active_coordinators: 'منسقون نشطون',

  /* --- routed but not yet built --- */
  screen_not_built_title: 'لم تُبنَ بعد',
  coming_in_stage_5: 'بيانات الإدارة — الفرق وجدول الموقع ← كود العمل والمستخدمون والقوائم — تأتي مع شاشات الإدارة.',
  coming_in_stage_6: 'شاشة إدخال البيانات تأتي مع شاشات المنسق.',
  coming_in_stage_7: 'الاعتمادات المجمّعة تأتي مع شاشة مراجعة المدير.',
  coming_in_stage_8: 'أداة التصدير وقالب الحسابات يأتيان مع شاشة التصدير.',

  change_password_title: 'تغيير كلمة المرور',
  not_found_title: 'الصفحة غير موجودة',
  not_found_subtitle: 'هذه الشاشة غير موجودة.',
  go_to_dashboard: 'الذهاب إلى الرئيسية',
  unknown_role_title: 'لا توجد صلاحية لهذا الحساب',
  unknown_role_text: 'حسابك غير مُعرّف كمنسق أو كمدير. اطلب من أحد المديرين مراجعته ثم سجّل الدخول مرة أخرى.',

  /* --- change password (4.3) --- */
  change_password_subtitle: 'اختر كلمة مرور جديدة لحسابك.',
  change_password_forced_subtitle: 'عيّن كلمة المرور الخاصة بك قبل المتابعة.',
  change_password_forced_notice: 'تم منح حسابك كلمة مرور مؤقتة. اختر كلمة المرور الخاصة بك للمتابعة.',
  change_password_new: 'كلمة المرور الجديدة',
  change_password_confirm: 'تأكيد كلمة المرور الجديدة',
  change_password_hint: 'لا تقل عن {min} أحرف.',
  change_password_submit: 'تعيين كلمة المرور',
  change_password_working: 'جارٍ الحفظ…',
  change_password_required: 'أدخل كلمة مرور جديدة.',
  change_password_too_short: 'استخدم {min} أحرف على الأقل.',
  change_password_mismatch: 'كلمتا المرور غير متطابقتين.',
  change_password_success: 'تم تغيير كلمة المرور.',

  /* --- errors: by envelope code (CLAUDE.md 3.1) --- */
  err_validation_failed: 'بعض البيانات المُرسلة غير صحيحة.',
  err_unauthenticated: 'انتهت جلستك. يرجى تسجيل الدخول مرة أخرى.',
  err_forbidden: 'لا تملك صلاحية تنفيذ هذا الإجراء.',
  err_not_found: 'تعذّر العثور على هذا العنصر.',
  err_conflict: 'قام شخص آخر بالتعديل قبلك. أعد تحميل الصفحة ثم حاول مجدداً.',
  err_server_error: 'حدثت مشكلة في الخادم. حاول بعد قليل.',
  err_network_error: 'لا يوجد ردّ من الخادم. تحقق من الاتصال.',
  err_script_url_missing: 'هذا الجهاز غير مرتبط بخادم بعد.',
  err_unknown: 'حدث خطأ ما.',

  /* --- errors: by server message, more specific than the code above --- */
  err_msg_invalid_credentials: 'اسم المستخدم أو كلمة المرور غير صحيحة.',
  err_msg_invalid_login_payload: 'أدخل اسم المستخدم وكلمة المرور.',
  err_msg_session_expired: 'انتهت صلاحية جلستك. يرجى تسجيل الدخول مرة أخرى.',
  err_msg_invalid_token: 'لم تعد جلستك صالحة. يرجى تسجيل الدخول مرة أخرى.',
  err_msg_missing_token: 'يرجى تسجيل الدخول مرة أخرى.',
  err_msg_user_inactive: 'تم إيقاف هذا الحساب.',
  err_msg_user_not_found: 'لم يعد هذا الحساب موجوداً.',
  err_msg_password_unchanged: 'هذه هي كلمة المرور الحالية. اختر كلمة مرور مختلفة.',
  err_msg_invalid_password: 'أدخل كلمة مرور جديدة.',
  err_msg_invalid_password_hash: 'تعذّر إرسال كلمة المرور بشكل آمن. أعد تحميل الصفحة وحاول مجدداً.',
  err_msg_manager_only: 'هذا الإجراء متاح للمدير فقط.',
  err_msg_unknown_action: 'هذه النسخة من التطبيق قديمة. أعد تحميل الصفحة.',
  err_msg_malformed_json: 'تعذّر على الخادم قراءة الطلب.',
  err_msg_malformed_response: 'أرسل الخادم رداً تعذّر على التطبيق قراءته.',
  err_msg_insecure_context: 'لا يمكن تشفير كلمة المرور إلا عبر HTTPS. افتح التطبيق عبر https://.'
};
