/*
 * Adapted from scrcpy (server/src/main/java/com/genymobile/scrcpy/Workarounds.java
 * and FakeContext.java), Copyright (C) 2018 Genymobile and
 * Copyright (C) 2018-2026 Romain Vimont, licensed under the Apache License,
 * Version 2.0: http://www.apache.org/licenses/LICENSE-2.0
 * Modified for hinge: only the system Context setup is kept.
 */
package net.garulf.hinge;

import android.content.Context;
import android.content.ContextWrapper;
import android.os.Build;
import android.os.Looper;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;

final class SystemContext extends ContextWrapper {

    private static final String SHELL_PACKAGE = "com.android.shell";
    private static final int ANDROID_12 = 31;

    private static Context instance;

    private SystemContext(Context base) {
        super(base);
    }

    @Override
    public String getPackageName() {
        return SHELL_PACKAGE;
    }

    @Override
    public String getOpPackageName() {
        return SHELL_PACKAGE;
    }

    static synchronized Context get() throws ReflectiveOperationException {
        if (instance == null) {
            instance = new SystemContext(createSystemContext());
        }
        return instance;
    }

    @SuppressWarnings("deprecation")
    private static Context createSystemContext() throws ReflectiveOperationException {
        Looper.prepareMainLooper();

        Class<?> activityThreadClass = Class.forName("android.app.ActivityThread");
        Constructor<?> constructor = activityThreadClass.getDeclaredConstructor();
        constructor.setAccessible(true);
        Object activityThread = constructor.newInstance();

        setField(activityThreadClass, null, "sCurrentActivityThread", activityThread);
        setField(activityThreadClass, activityThread, "mSystemThread", true);
        if (Build.VERSION.SDK_INT >= ANDROID_12) {
            installConfigurationController(activityThreadClass, activityThread);
        }

        Method getSystemContext = activityThreadClass.getDeclaredMethod("getSystemContext");
        getSystemContext.setAccessible(true);
        Context systemContext = (Context) getSystemContext.invoke(activityThread);
        if (systemContext == null) {
            throw new IllegalStateException("ActivityThread.getSystemContext() returned null");
        }
        return systemContext;
    }

    // Some Samsung builds call ActivityThread.getConfiguration() while creating the
    // system context, which needs a ConfigurationController (scrcpy issue #4467).
    private static void installConfigurationController(Class<?> activityThreadClass, Object activityThread) {
        try {
            Class<?> controllerClass = Class.forName("android.app.ConfigurationController");
            Class<?> activityThreadInternalClass = Class.forName("android.app.ActivityThreadInternal");
            Constructor<?> constructor = controllerClass.getDeclaredConstructor(activityThreadInternalClass);
            constructor.setAccessible(true);
            Object controller = constructor.newInstance(activityThread);
            setField(activityThreadClass, activityThread, "mConfigurationController", controller);
        } catch (ReflectiveOperationException | RuntimeException ignored) {
            // Best effort, as in scrcpy: devices without this need do not have the class.
        }
    }

    private static void setField(Class<?> owner, Object target, String name, Object value) throws ReflectiveOperationException {
        Field field = owner.getDeclaredField(name);
        field.setAccessible(true);
        field.set(target, value);
    }
}
