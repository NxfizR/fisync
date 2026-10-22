package com.fisync.app;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.CallLog;
import android.provider.MediaStore;
import android.provider.Telephony;
import android.telecom.TelecomManager;
import android.telephony.SmsManager;
import android.telephony.SmsMessage;
import android.telephony.TelephonyManager;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;

@CapacitorPlugin(name = "FiBridge", permissions = {
    @Permission(alias = "all", strings = {
        Manifest.permission.CALL_PHONE, Manifest.permission.READ_PHONE_STATE,
        Manifest.permission.READ_CALL_LOG, Manifest.permission.ANSWER_PHONE_CALLS,
        Manifest.permission.READ_SMS, Manifest.permission.SEND_SMS, Manifest.permission.RECEIVE_SMS,
        Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_EXTERNAL_STORAGE })
})
public class FiBridgePlugin extends Plugin {

    @Override
    public void load() {
        register(new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                JSObject o = new JSObject();
                o.put("state", i.getStringExtra(TelephonyManager.EXTRA_STATE));
                o.put("number", i.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER));
                notifyListeners("call", o);
            }
        }, new IntentFilter(TelephonyManager.ACTION_PHONE_STATE_CHANGED));

        register(new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                SmsMessage[] parts = Telephony.Sms.Intents.getMessagesFromIntent(i);
                if (parts == null || parts.length == 0) return;
                StringBuilder body = new StringBuilder();
                for (SmsMessage p : parts) body.append(p.getMessageBody());
                JSObject o = new JSObject();
                o.put("from", parts[0].getOriginatingAddress());
                o.put("body", body.toString());
                o.put("date", System.currentTimeMillis());
                notifyListeners("smsin", o);
            }
        }, new IntentFilter(Telephony.Sms.Intents.SMS_RECEIVED_ACTION));
    }

    private void register(BroadcastReceiver r, IntentFilter f) {
        if (Build.VERSION.SDK_INT >= 33) getContext().registerReceiver(r, f, Context.RECEIVER_EXPORTED);
        else getContext().registerReceiver(r, f);
    }

    private TelecomManager telecom() {
        return (TelecomManager) getContext().getSystemService(Context.TELECOM_SERVICE);
    }

    @PluginMethod
    public void requestAll(PluginCall call) { requestAllPermissions(call, "permsDone"); }

    @PermissionCallback
    private void permsDone(PluginCall call) { call.resolve(); }

    @PluginMethod
    public void dial(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_CALL, Uri.parse("tel:" + Uri.encode(call.getString("number", ""))));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try { getContext().startActivity(i); call.resolve(); }
        catch (SecurityException e) { call.reject("Call permission denied"); }
    }

    @PluginMethod
    public void answer(PluginCall call) {
        try { telecom().acceptRingingCall(); call.resolve(); }
        catch (SecurityException e) { call.reject("Permission denied"); }
    }

    @PluginMethod
    public void hangUp(PluginCall call) {
        try { telecom().endCall(); call.resolve(); }
        catch (SecurityException e) { call.reject("Permission denied"); }
    }

    @PluginMethod
    public void getCalls(PluginCall call) {
        int max = call.getInt("limit", 50);
        JSArray items = new JSArray();
        try (Cursor c = getContext().getContentResolver().query(CallLog.Calls.CONTENT_URI,
                new String[] { CallLog.Calls.NUMBER, CallLog.Calls.CACHED_NAME, CallLog.Calls.TYPE,
                    CallLog.Calls.DATE, CallLog.Calls.DURATION },
                null, null, CallLog.Calls.DATE + " DESC")) {
            while (c != null && c.moveToNext() && items.length() < max) {
                JSObject o = new JSObject();
                o.put("number", c.getString(0));
                o.put("name", c.getString(1));
                o.put("type", c.getInt(2));
                o.put("date", c.getLong(3));
                o.put("duration", c.getLong(4));
                items.put(o);
            }
        } catch (SecurityException e) { call.reject("Call log permission denied"); return; }
        JSObject r = new JSObject();
        r.put("items", items);
        call.resolve(r);
    }

    @PluginMethod
    public void getSms(PluginCall call) {
        int max = call.getInt("limit", 300);
        JSArray items = new JSArray();
        try (Cursor c = getContext().getContentResolver().query(Telephony.Sms.CONTENT_URI,
                new String[] { Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.TYPE },
                null, null, Telephony.Sms.DATE + " DESC")) {
            while (c != null && c.moveToNext() && items.length() < max) {
                JSObject o = new JSObject();
                o.put("address", c.getString(0));
                o.put("body", c.getString(1));
                o.put("date", c.getLong(2));
                o.put("type", c.getInt(3));
                items.put(o);
            }
        } catch (SecurityException e) { call.reject("SMS permission denied"); return; }
        JSObject r = new JSObject();
        r.put("items", items);
        call.resolve(r);
    }

    @PluginMethod
    public void sendSms(PluginCall call) {
        try {
            SmsManager sm = Build.VERSION.SDK_INT >= 31
                ? getContext().getSystemService(SmsManager.class) : SmsManager.getDefault();
            ArrayList<String> parts = sm.divideMessage(call.getString("body", ""));
            sm.sendMultipartTextMessage(call.getString("to", ""), null, parts, null, null);
            call.resolve();
        } catch (Exception e) { call.reject("Could not send: " + e.getMessage()); }
    }

    @PluginMethod
    public void listPhotos(PluginCall call) {
        int max = call.getInt("limit", 30);
        JSArray items = new JSArray();
        try (Cursor c = getContext().getContentResolver().query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                new String[] { MediaStore.Images.Media._ID, MediaStore.Images.Media.DISPLAY_NAME },
                null, null, MediaStore.Images.Media.DATE_ADDED + " DESC")) {
            while (c != null && c.moveToNext() && items.length() < max) {
                JSObject o = new JSObject();
                o.put("id", c.getLong(0));
                o.put("name", c.getString(1));
                items.put(o);
            }
        } catch (SecurityException e) { call.reject("Photo permission denied"); return; }
        JSObject r = new JSObject();
        r.put("items", items);
        call.resolve(r);
    }

    @PluginMethod
    public void readPhoto(PluginCall call) {
        Uri uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, (long) call.getInt("id", 0));
        try (InputStream src = getContext().getContentResolver().openInputStream(uri)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[65536];
            int n;
            while ((n = src.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > 15_000_000) { call.reject("Photo too large"); return; }
            }
            JSObject r = new JSObject();
            r.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            call.resolve(r);
        } catch (Exception e) { call.reject("Could not read photo"); }
    }
}
