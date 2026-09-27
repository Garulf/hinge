package net.garulf.hinge;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class Agent {

    private static final String USAGE = "usage: Agent apps | Agent icons <px> <pkg> [<pkg> ...]";

    private Agent() {
    }

    public static void main(String[] args) {
        try {
            System.out.println(run(args));
            System.out.flush();
            System.exit(0);
        } catch (Throwable failure) {
            String message = failure.getMessage() != null ? failure.getMessage() : failure.toString();
            System.err.println("hinge-agent: " + message);
            System.exit(1);
        }
    }

    private static String run(String[] args) throws Exception {
        if (args.length == 0) {
            throw new IllegalArgumentException(USAGE);
        }
        switch (args[0]) {
            case "apps":
                return listApps(packageManager()).toString();
            case "icons":
                if (args.length < 3) {
                    throw new IllegalArgumentException(USAGE);
                }
                return renderIcons(packageManager(), parseSize(args[1]), Arrays.copyOfRange(args, 2, args.length)).toString();
            default:
                throw new IllegalArgumentException("unknown command: " + args[0] + "\n" + USAGE);
        }
    }

    private static PackageManager packageManager() throws ReflectiveOperationException {
        Context context = SystemContext.get();
        return context.getPackageManager();
    }

    private static int parseSize(String text) {
        int px;
        try {
            px = Integer.parseInt(text);
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("icon size is not a number: " + text);
        }
        if (px <= 0) {
            throw new IllegalArgumentException("icon size must be positive: " + text);
        }
        return px;
    }

    private static JSONArray listApps(PackageManager pm) throws JSONException {
        Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        Map<String, ApplicationInfo> appsByPackage = new LinkedHashMap<>();
        for (ResolveInfo activity : pm.queryIntentActivities(launcher, 0)) {
            ApplicationInfo app = activity.activityInfo.applicationInfo;
            appsByPackage.putIfAbsent(app.packageName, app);
        }

        List<LaunchableApp> apps = new ArrayList<>();
        for (ApplicationInfo app : appsByPackage.values()) {
            long versionCode;
            try {
                versionCode = pm.getPackageInfo(app.packageName, 0).getLongVersionCode();
            } catch (PackageManager.NameNotFoundException uninstalledMeanwhile) {
                continue;
            }
            apps.add(new LaunchableApp(app.packageName, pm.getApplicationLabel(app).toString(), versionCode));
        }
        apps.sort(Comparator.comparing((LaunchableApp app) -> app.label, String.CASE_INSENSITIVE_ORDER)
                .thenComparing(app -> app.pkg));

        JSONArray json = new JSONArray();
        for (LaunchableApp app : apps) {
            json.put(app.toJson());
        }
        return json;
    }

    private static JSONObject renderIcons(PackageManager pm, int px, String[] packages) throws JSONException {
        JSONObject json = new JSONObject();
        for (String pkg : packages) {
            String png;
            try {
                png = iconAsBase64Png(pm.getApplicationIcon(pkg), px);
            } catch (Exception unrenderable) {
                continue;
            }
            json.put(pkg, png);
        }
        return json;
    }

    private static String iconAsBase64Png(Drawable icon, int px) {
        Bitmap bitmap = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888);
        try {
            icon.setBounds(0, 0, px, px);
            icon.draw(new Canvas(bitmap));
            ByteArrayOutputStream png = new ByteArrayOutputStream();
            if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, png)) {
                throw new IllegalStateException("PNG encoding failed");
            }
            return Base64.encodeToString(png.toByteArray(), Base64.NO_WRAP);
        } finally {
            bitmap.recycle();
        }
    }

    private static final class LaunchableApp {
        final String pkg;
        final String label;
        final long versionCode;

        LaunchableApp(String pkg, String label, long versionCode) {
            this.pkg = pkg;
            this.label = label;
            this.versionCode = versionCode;
        }

        JSONObject toJson() throws JSONException {
            return new JSONObject()
                    .put("pkg", pkg)
                    .put("label", label)
                    .put("versionCode", versionCode);
        }
    }
}
