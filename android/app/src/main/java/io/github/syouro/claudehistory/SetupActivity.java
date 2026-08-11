package io.github.syouro.claudehistory;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.widget.Button;
import android.widget.EditText;

public class SetupActivity extends Activity {
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_setup);

        EditText input = findViewById(R.id.url);
        input.setText(getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE)
                .getString(MainActivity.KEY_URL, ""));

        Button save = findViewById(R.id.save);
        save.setOnClickListener(v -> {
            String url = input.getText().toString().trim();
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
                input.setError(getString(R.string.url_error));
                return;
            }
            getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE).edit()
                    .putString(MainActivity.KEY_URL, url).apply();
            startActivity(new Intent(this, MainActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP));
            finish();
        });
    }
}
