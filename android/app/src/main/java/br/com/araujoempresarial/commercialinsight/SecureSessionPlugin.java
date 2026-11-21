package br.com.araujoempresarial.commercialinsight;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "SecureSession")
public class SecureSessionPlugin extends Plugin {

    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "commercial_insight_session_v1";
    private static final String PREFS_NAME = "ci_secure_session";
    private static final String TOKEN_ENTRY = "session_cipher";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int GCM_TAG_BITS = 128;

    private synchronized SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) keyStore.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator keyGen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .build();
        keyGen.init(spec);
        return keyGen.generateKey();
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void set(PluginCall call) {
        String value = call.getString("value");
        if (value == null || !value.matches("^[a-f0-9]{64}$")) {
            call.reject("Token de sessão inválido.");
            return;
        }
        try {
            SecretKey key = getOrCreateKey();
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, key);
            byte[] iv = cipher.getIV();
            byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            String encoded =
                Base64.encodeToString(iv, Base64.NO_WRAP) +
                ":" +
                Base64.encodeToString(encrypted, Base64.NO_WRAP);
            prefs().edit().putString(TOKEN_ENTRY, encoded).apply();
            call.resolve();
        } catch (Exception ex) {
            call.reject("Não foi possível proteger a sessão no Keystore.", ex);
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        JSObject result = new JSObject();
        String encoded = prefs().getString(TOKEN_ENTRY, null);
        if (encoded == null || !encoded.contains(":")) {
            result.put("value", JSObject.NULL);
            call.resolve(result);
            return;
        }
        try {
            String[] parts = encoded.split(":", 2);
            byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
            byte[] encrypted = Base64.decode(parts[1], Base64.NO_WRAP);
            SecretKey key = getOrCreateKey();
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_BITS, iv));
            String plain = new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
            if (!plain.matches("^[a-f0-9]{64}$")) {
                prefs().edit().remove(TOKEN_ENTRY).apply();
                result.put("value", JSObject.NULL);
            } else {
                result.put("value", plain);
            }
            call.resolve(result);
        } catch (Exception ex) {
            prefs().edit().remove(TOKEN_ENTRY).apply();
            result.put("value", JSObject.NULL);
            call.resolve(result);
        }
    }

    @PluginMethod
    public void clear(PluginCall call) {
        prefs().edit().remove(TOKEN_ENTRY).apply();
        call.resolve();
    }
}
