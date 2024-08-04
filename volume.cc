#include <node.h>
#include <alsa/asoundlib.h>

namespace demo {

using v8::FunctionCallbackInfo;
using v8::Isolate;
using v8::Local;
using v8::Object;
using v8::Number;
using v8::Value;

void GetVolume(const FunctionCallbackInfo<Value>& args) {
  Isolate* isolate = args.GetIsolate();

  long min, max;
  long volume = 0;
  int err;
  snd_mixer_t *handle = nullptr;
  snd_mixer_selem_id_t *sid;
  const char *card = "default";
  const char *selem_name = "Master";

  err = snd_mixer_open(&handle, 0);
  if (err < 0) {
    args.GetReturnValue().Set(Number::New(isolate, -1));
    return;
  }

  err = snd_mixer_attach(handle, card);
  if (err < 0) {
    snd_mixer_close(handle);
    args.GetReturnValue().Set(Number::New(isolate, -1));
    return;
  }

  err = snd_mixer_selem_register(handle, NULL, NULL);
  if (err < 0) {
    snd_mixer_close(handle);
    args.GetReturnValue().Set(Number::New(isolate, -1));
    return;
  }

  err = snd_mixer_load(handle);
  if (err < 0) {
    snd_mixer_close(handle);
    args.GetReturnValue().Set(Number::New(isolate, -1));
    return;
  }

  snd_mixer_selem_id_alloca(&sid);
  snd_mixer_selem_id_set_index(sid, 0);
  snd_mixer_selem_id_set_name(sid, selem_name);

  snd_mixer_elem_t* elem = snd_mixer_find_selem(handle, sid);
  if (!elem) {
    snd_mixer_close(handle);
    args.GetReturnValue().Set(Number::New(isolate, -1));
    return;
  }

  err = snd_mixer_selem_get_playback_volume_range(elem, &min, &max);
  if (err < 0) {
    snd_mixer_close(handle);
    args.GetReturnValue().Set(Number::New(isolate, -1));
    return;
  }

  err = snd_mixer_selem_get_playback_volume(elem, SND_MIXER_SCHN_FRONT_LEFT, &volume);
  if (err < 0) {
    snd_mixer_close(handle);
    args.GetReturnValue().Set(Number::New(isolate, -1));
    return;
  }

  snd_mixer_close(handle);

  // Convert to percentage
  long volumePercent = ((volume - min) * 100) / (max - min);
  args.GetReturnValue().Set(Number::New(isolate, volumePercent));
}

void Initialize(Local<Object> exports) {
  NODE_SET_METHOD(exports, "getVolume", GetVolume);
}

NODE_MODULE(NODE_GYP_MODULE_NAME, Initialize)

}  // namespace demo
